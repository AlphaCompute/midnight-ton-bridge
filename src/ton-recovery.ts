import {Address,beginCell,Cell,storeMessage,type Transaction} from '@ton/core';
import type {TonClient4} from '@ton/ton';
import {referenceWallet,verifyAsset,type JettonAsset} from './jettons.js';
import {assertTonTestnet} from './ton-network.js';
export type TxLocator={lt:string;hash:string};
export type FailureTrace={source:TxLocator;rejection:TxLocator;bounce:TxLocator;recipientWallet:string};
const hashMessage=(m:NonNullable<Transaction['inMessage']>)=>beginCell().store(storeMessage(m)).endCell().hash();
const success=(tx:Transaction)=>tx.description.type==='generic'&&!tx.description.aborted&&tx.description.computePhase.type==='vm'&&tx.description.computePhase.success&&(!tx.description.actionPhase||tx.description.actionPhase.success);
async function fetchTx(client:TonClient4,block:number,address:Address,loc:TxLocator){
 if(!/^\d+$/.test(loc.lt)||!/^[0-9a-f]{64}$/.test(loc.hash))throw new Error('Invalid transaction locator');
 const account=await client.getAccountLite(block,address);
 if(!account.account.last||BigInt(account.account.last.lt)<BigInt(loc.lt))throw new Error('Transaction is not finalized');
 const rows=await client.getAccountTransactions(address,BigInt(loc.lt),Buffer.from(loc.hash,'hex'));
 const tx=rows.find(x=>x.tx.lt===BigInt(loc.lt)&&x.tx.hash().toString('hex')===loc.hash)?.tx;
 if(!tx||tx.address!==BigInt('0x'+address.hash.toString('hex')))throw new Error('Exact transaction not found');return tx;
}
export type UnrecordedTrace={credit:TxLocator;notification?:TxLocator};
/** Prove a finalized jetton credit to the escrow's wallet that the escrow never
 * recorded: sent by the original sender's own reference wallet, and its notification
 * either never emitted or not successfully processed. Never infer it from balances. */
export async function observeUnrecordedCredit(client:TonClient4,asset:JettonAsset,escrow:Address,trace:UnrecordedTrace){
 const verified=await verifyAsset(client,asset,escrow),wallet=Address.parse(verified.wallet),master=Address.parse(asset.master),code=Cell.fromBase64(asset.walletCodeBoc);
 const head=await client.getLastBlock();assertTonTestnet(head);const block=Math.min(verified.block,head.last.seqno-3);
 const credit=await fetchTx(client,block,wallet,trace.credit);
 const incoming=credit.inMessage;if(!success(credit)||!incoming||incoming.info.type!=='internal'||incoming.info.bounced)throw new Error('Not a successful internal credit');
 const body=incoming.body.beginParse();if(body.loadUint(32)!==0x178d4519)throw new Error('Not a jetton internal transfer');
 body.loadUintBig(64);const amount=body.loadCoins(),from=body.loadAddress();body.loadMaybeAddress();const forward=body.loadCoins();
 if(amount<=0n||amount>=1n<<64n||!from||from.workChain!==0)throw new Error('Credit is not refundable through the ledger');
 if(!incoming.info.src.equals(referenceWallet(from,master,code).address))throw new Error('Credit was not sent by the original sender wallet');
 const notices=[...credit.outMessages.values()].filter(m=>m.info.type==='internal'&&m.info.dest.equals(escrow));
 if(forward===0n){if(notices.length||trace.notification)throw new Error('Zero-forward credit must not notify the escrow');}
 else{
  if(notices.length!==1||!trace.notification)throw new Error('Notification and its escrow transaction are required');
  const handled=await fetchTx(client,block,escrow,trace.notification),m=handled.inMessage;
  if(!m||!hashMessage(m).equals(hashMessage(notices[0]!)))throw new Error('Escrow transaction did not process this notification');
  const d=handled.description;
  if(d.type!=='generic'||!(d.computePhase.type==='skipped'||!d.computePhase.success))throw new Error('Escrow processed the notification; use its deposit or refund record');
 }
 return {evidence:credit.hash(),amount,from,block,creditTx:credit.hash().toString('hex')};
}
/** Verify all three exact messages: escrow wallet sends, recipient rejects, source
 * wallet processes that bounce. Never infer failure from timeout or balance alone. */
export async function observeFailedTransfer(client:TonClient4,asset:JettonAsset,escrow:Address,query:bigint,amount:bigint,trace:FailureTrace){
 const verified=await verifyAsset(client,asset,escrow),source=Address.parse(verified.wallet),recipient=Address.parse(trace.recipientWallet);
 const head=await client.getLastBlock();assertTonTestnet(head);const block=Math.min(verified.block,head.last.seqno-3);
 async function fetch(address:Address,loc:TxLocator){
  if(!/^\d+$/.test(loc.lt)||!/^[0-9a-f]{64}$/.test(loc.hash))throw new Error('Invalid transaction locator');
  const account=await client.getAccountLite(block,address);
  if(!account.account.last||BigInt(account.account.last.lt)<BigInt(loc.lt))throw new Error('Transaction is not finalized');
  const rows=await client.getAccountTransactions(address,BigInt(loc.lt),Buffer.from(loc.hash,'hex'));
  const tx=rows.find(x=>x.tx.lt===BigInt(loc.lt)&&x.tx.hash().toString('hex')===loc.hash)?.tx;
  if(!tx||tx.address!==BigInt('0x'+address.hash.toString('hex')))throw new Error('Exact transaction not found');return tx;
 }
 const sent=await fetch(source,trace.source),rejected=await fetch(recipient,trace.rejection),returned=await fetch(source,trace.bounce);
 if(!success(sent)||!success(returned)||rejected.description.type!=='generic'||!rejected.description.aborted||!rejected.description.bouncePhase||rejected.description.bouncePhase.type!=='ok')throw new Error('Not a successful send / actual recipient bounce / successful restoration');
 const original=sent.inMessage;if(!original||original.info.type!=='internal'||original.info.bounced||!original.info.src.equals(escrow))throw new Error('Transfer was not instructed by escrow');
 const request=original.body.beginParse();if(request.loadUint(32)!==0x0f8a7ea5||request.loadUintBig(64)!==query||request.loadCoins()!==amount)throw new Error('Escrow instruction mismatch');
 const incoming=rejected.inMessage,back=returned.inMessage;
 if(!incoming||incoming.info.type!=='internal'||incoming.info.bounced||!incoming.info.src.equals(source)||!back||back.info.type!=='internal'||!back.info.bounced||!back.info.src.equals(recipient))throw new Error('Wrong trace participants');
 if(![...sent.outMessages.values()].some(m=>hashMessage(m).equals(hashMessage(incoming)))||![...rejected.outMessages.values()].some(m=>hashMessage(m).equals(hashMessage(back))))throw new Error('Trace message hashes do not link');
 const body=incoming.body.beginParse();if(body.loadUint(32)!==0x178d4519||body.loadUintBig(64)!==query||body.loadCoins()!==amount||!body.loadAddress().equals(escrow))throw new Error('Internal transfer mismatch');
 const bounce=back.body.beginParse();if(bounce.loadUint(32)!==0xffffffff||bounce.loadUint(32)!==0x178d4519||bounce.loadUintBig(64)!==query||bounce.loadCoins()!==amount)throw new Error('Bounce body mismatch');
 if(returned.lt<=sent.lt||returned.lt<=rejected.lt)throw new Error('Invalid trace order');
 return {evidence:returned.hash(),block,sourceTx:sent.hash().toString('hex'),rejectionTx:rejected.hash().toString('hex'),bounceTx:returned.hash().toString('hex')};
}
