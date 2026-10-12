import {Address,beginCell,Cell,storeMessage,type Message,type Transaction} from '@ton/core';
import type {TonClient4} from '@ton/ton';
import {referenceWallet,verifyAsset,type JettonAsset} from './jettons.js';
import {finalizedBlock} from './ton-network.js';
import {OP,u64} from './ton.js';

/** Trusted-RPC readers of exact TON transaction traces: delivery, failure and stranded credits. */
export type TxLocator={lt:string;hash:string};
export type FailureTrace={source:TxLocator;rejection:TxLocator;bounce:TxLocator;recipientWallet:string};
export type UnrecordedTrace={credit:TxLocator;notification?:TxLocator};
/** Generic transaction whose compute (and any action) phase succeeded. */
export const txSucceeded=(tx:Transaction)=>tx.description.type==='generic'&&!tx.description.aborted&&tx.description.computePhase.type==='vm'&&tx.description.computePhase.success&&(!tx.description.actionPhase||tx.description.actionPhase.success);
export const messageHash=(m:Message)=>beginCell().store(storeMessage(m)).endCell().hash();
export const txLocator=(tx:Transaction):TxLocator=>({lt:tx.lt.toString(),hash:tx.hash().toString('hex')});

/** The most recent page of `address`'s transactions as of finalized `block`. */
export async function recentTransactions(client:TonClient4,block:number,address:Address):Promise<Transaction[]>{
 const a=await client.getAccountLite(block,address);if(!a.account.last)return [];
 return (await client.getAccountTransactions(address,BigInt(a.account.last.lt),Buffer.from(a.account.last.hash,'base64'))).map(r=>r.tx);
}
/** Finalized recipient credit and the matching outgoing internal message from the
 * expected jetton sender wallet, both in recent history. */
export async function verifyJettonDelivery(client:TonClient4,from:Address,to:Address,queryId:bigint,amount:bigint,depth=3){
 const {block}=await finalizedBlock(client,depth);
 const destination=await recentTransactions(client,block,to),source=await recentTransactions(client,block,from);
 if(!destination.length)throw new Error('no transaction history');
 for(const tx of destination){const m=tx.inMessage;if(!m||m.info.type!=='internal'||m.info.bounced||!m.info.src.equals(from)||!txSucceeded(tx))continue;
  const b=m.body.beginParse();if(b.remainingBits<96||b.loadUint(32)!==OP.internalTransfer||b.loadUintBig(64)!==queryId||b.loadCoins()!==amount)continue;
  const hash=messageHash(m);
  const parent=source.find(t=>txSucceeded(t)&&[...t.outMessages.values()].some(out=>messageHash(out).equals(hash)));
  if(!parent)throw new Error('recipient credit has no matching successful sender transaction in recent history');
  return {block,queryId:queryId.toString(),amount:amount.toString(),from:from.toRawString(),to:to.toRawString(),sourceTx:parent.hash().toString('hex'),recipientTx:tx.hash().toString('hex'),messageHash:hash.toString('hex')};
 }
 throw new Error('matching finalized jetton recipient credit not found');
}

/** Exact transaction at a locator, only once the account's state at `block` includes it. */
async function fetchTx(client:TonClient4,block:number,address:Address,loc:TxLocator){
 if(!/^\d+$/.test(loc.lt)||!/^[0-9a-f]{64}$/.test(loc.hash))throw new Error('Invalid transaction locator');
 const account=await client.getAccountLite(block,address);
 if(!account.account.last||BigInt(account.account.last.lt)<BigInt(loc.lt))throw new Error('Transaction is not finalized');
 const rows=await client.getAccountTransactions(address,BigInt(loc.lt),Buffer.from(loc.hash,'hex'));
 const tx=rows.find(x=>x.tx.lt===BigInt(loc.lt)&&x.tx.hash().toString('hex')===loc.hash)?.tx;
 if(!tx||tx.address!==BigInt('0x'+address.hash.toString('hex')))throw new Error('Exact transaction not found');return tx;
}
/** Escrow's verified jetton wallet and a block final for both it and the asset pins. */
async function escrowWalletAt(client:TonClient4,asset:JettonAsset,escrow:Address){
 const verified=await verifyAsset(client,asset,escrow),{block}=await finalizedBlock(client);
 return {wallet:Address.parse(verified.wallet),block:Math.min(verified.block,block)};
}

/** Prove a finalized jetton credit to the escrow's wallet that the escrow never
 * recorded: sent by the original sender's own reference wallet, and its notification
 * either never emitted or not successfully processed. Never infer it from balances. */
export async function observeUnrecordedCredit(client:TonClient4,asset:JettonAsset,escrow:Address,trace:UnrecordedTrace){
 const {wallet,block}=await escrowWalletAt(client,asset,escrow),master=Address.parse(asset.master),code=Cell.fromBase64(asset.walletCodeBoc);
 const credit=await fetchTx(client,block,wallet,trace.credit);
 const incoming=credit.inMessage;if(!txSucceeded(credit)||!incoming||incoming.info.type!=='internal'||incoming.info.bounced)throw new Error('Not a successful internal credit');
 const body=incoming.body.beginParse();if(body.loadUint(32)!==OP.internalTransfer)throw new Error('Not a jetton internal transfer');
 body.loadUintBig(64);const amount=body.loadCoins(),from=body.loadMaybeAddress();body.loadMaybeAddress();const forward=body.loadCoins();
 if(amount<=0n||!from||from.workChain!==0)throw new Error('Credit is not refundable to a basechain sender');
 if(!incoming.info.src.equals(referenceWallet(from,master,code).address))throw new Error('Credit was not sent by the original sender wallet');
 // Only the transfer notification counts: an `excesses` message to the escrow (when it is the
 // response address) is not a notification and must not block recovery.
 const notices=[...credit.outMessages.values()].filter(m=>m.info.type==='internal'&&m.info.dest.equals(escrow)&&m.body.beginParse().remainingBits>=32&&m.body.beginParse().preloadUint(32)===OP.transferNotification);
 if(forward===0n){if(notices.length||trace.notification)throw new Error('Zero-forward credit must not notify the escrow');}
 else{
  if(notices.length!==1||!trace.notification)throw new Error('Notification and its escrow transaction are required');
  const handled=await fetchTx(client,block,escrow,trace.notification),m=handled.inMessage;
  if(!m||!messageHash(m).equals(messageHash(notices[0]!)))throw new Error('Escrow transaction did not process this notification');
  const d=handled.description;
  if(d.type!=='generic'||!(d.computePhase.type==='skipped'||!d.computePhase.success))throw new Error('Escrow processed the notification; use its deposit or refund record');
 }
 return {evidence:credit.hash(),amount,from,block,creditTx:credit.hash().toString('hex')};
}
/** Verify all three exact messages: escrow wallet sends, recipient rejects, source
 * wallet processes that bounce. Never infer failure from timeout or balance alone. */
export async function observeFailedTransfer(client:TonClient4,asset:JettonAsset,escrow:Address,query:bigint,amount:bigint,trace:FailureTrace){
 u64(query);
 const {wallet:source,block}=await escrowWalletAt(client,asset,escrow),recipient=Address.parse(trace.recipientWallet);
 const sent=await fetchTx(client,block,source,trace.source),rejected=await fetchTx(client,block,recipient,trace.rejection),returned=await fetchTx(client,block,source,trace.bounce);
 if(!txSucceeded(sent)||!txSucceeded(returned)||rejected.description.type!=='generic'||!rejected.description.aborted||!rejected.description.bouncePhase||rejected.description.bouncePhase.type!=='ok')throw new Error('Not a successful send / actual recipient bounce / successful restoration');
 const original=sent.inMessage;if(!original||original.info.type!=='internal'||original.info.bounced||!original.info.src.equals(escrow))throw new Error('Transfer was not instructed by escrow');
 const request=original.body.beginParse();if(request.loadUint(32)!==OP.jettonTransfer||request.loadUintBig(64)!==query||request.loadCoins()!==amount)throw new Error('Escrow instruction mismatch');
 const incoming=rejected.inMessage,back=returned.inMessage;
 if(!incoming||incoming.info.type!=='internal'||incoming.info.bounced||!incoming.info.src.equals(source)||!back||back.info.type!=='internal'||!back.info.bounced||!back.info.src.equals(recipient))throw new Error('Wrong trace participants');
 if(![...sent.outMessages.values()].some(m=>messageHash(m).equals(messageHash(incoming)))||![...rejected.outMessages.values()].some(m=>messageHash(m).equals(messageHash(back))))throw new Error('Trace message hashes do not link');
 const body=incoming.body.beginParse();if(body.loadUint(32)!==OP.internalTransfer||body.loadUintBig(64)!==query||body.loadCoins()!==amount||!body.loadAddress().equals(escrow))throw new Error('Internal transfer mismatch');
 const bounce=back.body.beginParse();if(bounce.loadUint(32)!==OP.bounced||bounce.loadUint(32)!==OP.internalTransfer||bounce.loadUintBig(64)!==query||bounce.loadCoins()!==amount)throw new Error('Bounce body mismatch');
 if(returned.lt<=sent.lt||returned.lt<=rejected.lt)throw new Error('Invalid trace order');
 return {evidence:returned.hash(),block,sourceTx:sent.hash().toString('hex'),rejectionTx:rejected.hash().toString('hex'),bounceTx:returned.hash().toString('hex')};
}
