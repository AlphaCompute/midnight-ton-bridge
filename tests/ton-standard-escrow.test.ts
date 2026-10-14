import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Address,beginCell,Cell,toNano,TupleReader,type Builder,type Transaction} from '@ton/core';
import {internal} from '@ton/sandbox';
import {OP,TonContract,escrowData,transferBody,releaseDigest,releaseBody,refundBody,DEPOSIT_ATTACHED_TON,DEPOSIT_FORWARD_TON} from '../src/ton.js';
import {referenceWallet,referenceMintBody,validateAssets,verifyAsset,failureDigest,failureBody,unrecordedDigest,unrecordedBody} from '../src/jettons.js';
import {observeFailedTransfer,observeUnrecordedCredit,txLocator} from '../src/ton-traces.js';
import {quorumSign,accountId,exitOf,rawTransfer,TON_COMMITTEE} from './helpers/ton.js';
import {route,STANDARD_DOMAIN} from './helpers/standard-route.js';

type Sent={transactions:Transaction[]};

test('standard escrow: capacity refunds, payload forms, excesses and unknown operations',async()=>{
 const r=await route(1000n),to=Buffer.alloc(32,9);
 // Recipient carried in a reference (Either right) is accepted like the inline form.
 const inRef=rawTransfer({query:1n,amount:300n,to:r.escrow.address,response:r.user.address,payload:b=>b.storeBit(true).storeRef(beginCell().storeBuffer(to).endCell())});
 await r.wallet.send(r.user.getSender(),inRef);assert.equal(await r.escrow.getNumber('locked'),300n);
 await r.wallet.send(r.user.getSender(),transferBody(2n,600n,r.escrow.address,r.user.address,to));assert.equal(await r.escrow.getNumber('locked'),900n);
 // Over the remaining capacity, over the per-escrow cap, and a malformed recipient all become exact refunds.
 await r.wallet.send(r.user.getSender(),transferBody(3n,101n,r.escrow.address,r.user.address,to));
 await r.wallet.send(r.user.getSender(),transferBody(4n,1001n,r.escrow.address,r.user.address,to));
 await r.wallet.send(r.user.getSender(),rawTransfer({query:5n,amount:7n,to:r.escrow.address,response:r.user.address,payload:b=>b.storeBit(false).storeBuffer(to).storeBit(true)}));
 assert.equal(await r.escrow.getNumber('locked'),900n);assert.equal(await r.escrow.getNumber('depositCount'),2n);assert.equal(await r.escrow.getNumber('refundCount'),3n);
 assert.equal(await r.balance(r.escrowWallet),900n+101n+1001n+7n);
 for(const id of [0n,1n,2n])await r.escrow.send(r.attacker.getSender(),refundBody(id));
 assert.equal(await r.balance(r.escrowWallet),900n);assert.equal(await r.balance(r.wallet),10000n-900n);
 // Returned TON from the jetton wallet is accepted silently; unknown operations bounce.
 const excess=await r.escrow.send(r.attacker.getSender(),beginCell().storeUint(OP.excesses,32).storeUint(0,64).endCell());assert.equal(exitOf(excess,r.escrow.address),0);
 const unknown=await r.escrow.send(r.attacker.getSender(),beginCell().storeUint(0x12345678,32).endCell());assert.equal(exitOf(unknown,r.escrow.address),400);
 const topUp=await r.escrow.send(r.attacker.getSender(),Cell.EMPTY);assert.equal(exitOf(topUp,r.escrow.address),0);
 // A transfer notification not sent by the escrow's own jetton wallet records nothing.
 const forged=beginCell().storeUint(OP.transferNotification,32).storeUint(0,64).storeCoins(500n).storeAddress(r.attacker.address).storeBit(false).storeBuffer(to).endCell();
 assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),forged),r.escrow.address),401);
 assert.equal(await r.escrow.getNumber('locked'),900n);assert.equal(await r.escrow.getNumber('depositCount'),2n);assert.equal(await r.escrow.getNumber('refundCount'),3n);
 // A refund needs enough TON to pay for the outgoing jetton transfer.
 assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),refundBody(0n),toNano('0.1')),r.escrow.address),403);
});

test('standard escrow: release guards fail closed',async()=>{
 const r=await route(1000n),id=Buffer.alloc(32,3),send=async(body:Cell,value?:bigint)=>exitOf(await r.escrow.send(r.attacker.getSender(),body,value),r.escrow.address);
 await r.wallet.send(r.user.getSender(),transferBody(1n,500n,r.escrow.address,r.user.address,Buffer.alloc(32,9)));
 const ok=r.release(id,100n,r.user.address);
 assert.equal(await send(ok,toNano('0.1')),403);
 assert.equal(await send(r.release(Buffer.alloc(32,4),501n,r.user.address)),405);
 // Same signer twice and a signature from the wrong committee slot.
 const d=releaseDigest(r.escrow.address,r.domain,id,100n,r.user.address),[sig,sig2]=quorumSign(d);
 const dup=beginCell().storeUint(OP.release,32).storeBuffer(id).storeUint(100n,64).storeAddress(r.user.address).storeUint(1,8).storeUint(1,8).storeRef(beginCell().storeBuffer(sig).endCell()).storeRef(beginCell().storeBuffer(sig).endCell()).endCell();
 assert.equal(await send(dup),404);
 assert.equal(await send(releaseBody(id,100n,r.user.address,0,1,sig,sig2)),408);
 // Signatures do not transfer to another recipient.
 assert.equal(await send(releaseBody(id,100n,r.attacker.address,0,2,sig,sig2)),407);
 const masterchain=new Address(-1,Buffer.alloc(32,5));
 const toMasterchain=beginCell().storeUint(OP.release,32).storeBuffer(id).storeUint(100n,64).storeAddress(masterchain).storeUint(0,8).storeUint(2,8).storeRef(beginCell().storeBuffer(sig).endCell()).storeRef(beginCell().storeBuffer(sig2).endCell()).endCell();
 assert.equal(await send(toMasterchain),411);
 assert.equal(await r.escrow.getNumber('locked'),500n);
 assert.equal(await send(ok),0);
 assert.equal(await r.escrow.getNumber('locked'),400n);assert.equal(await r.balance(r.wallet),9600n);
 assert.equal(await send(ok),406);
 assert.equal(await r.escrow.getNumber('locked'),400n);
});

test('standard escrow: verifyAsset pins master code, wallet code and address derivation; validateAssets rejects bad sets',async()=>{
 const r=await route(1000n),{asset,client,escrow}=r;
 const verified=await verifyAsset(client,asset,escrow.address);
 assert.equal(verified.wallet,referenceWallet(escrow.address,r.master.address,r.wc).address.toRawString());assert.equal(verified.wallet,r.escrowWallet.address.toRawString());
 await assert.rejects(()=>verifyAsset(client,{...asset,masterCodeHash:'ff'.repeat(32)},escrow.address),/pin mismatch/);
 await assert.rejects(()=>verifyAsset(client,{...asset,walletCodeHash:'ff'.repeat(32)},escrow.address),/wallet code mismatch/);
 const wrongLayout=new Proxy(client,{get:(target,prop)=>prop==='runMethod'?async(block:number,address:Address,name:string,args:any[])=>name==='get_wallet_address'?{exitCode:0,reader:new TupleReader([{type:'slice',cell:beginCell().storeAddress(r.attacker.address).endCell()}])}:target.runMethod(block,address,name,args):Reflect.get(target,prop)});
 await assert.rejects(()=>verifyAsset(wrongLayout,asset,escrow.address),/derivation mismatch/);
 const second={...asset,asset:1 as const,master:new Address(0,Buffer.alloc(32,8)).toRawString()};
 assert.equal(validateAssets([asset,second])[1].master,second.master);
 assert.throws(()=>validateAssets([asset,{...asset,asset:1}]),/Distinct/);
 assert.throws(()=>validateAssets([asset,{...second,walletCodeHash:'ff'.repeat(32)}]),/hash mismatch/);
});

/** Locator trace of a failed escrow jetton transfer: send, recipient rejection, bounce back. */
const failureTrace=(failed:Sent,source:Address,recipient:Address)=>{
 const find=(addr:Address,bounced:boolean)=>failed.transactions.find(tx=>tx.address===accountId(addr)&&tx.inMessage?.info.type==='internal'&&tx.inMessage.info.bounced===bounced);
 const s=find(source,false),j=find(recipient,false),b=find(source,true);assert(s&&j&&b,'actual downstream bounce trace required');
 return {source:txLocator(s),rejection:txLocator(j),bounce:txLocator(b),recipientWallet:recipient.toRawString()};
};

test('standard escrow: a refund rejected downstream is restored by quorum and paid on retry',async()=>{
 const r=await route(1000n);
 await r.wallet.send(r.user.getSender(),transferBody(1n,250n,r.escrow.address,r.user.address));
 assert.equal(await r.escrow.getNumber('refundCount'),1n);
 // The sender's wallet cannot accept the refund: its balance would overflow.
 const restore=await r.setBalance(r.wallet.address,r.user.address,(1n<<120n)-1n);
 const failed=await r.escrow.send(r.attacker.getSender(),refundBody(0n));r.setHistory(failed.transactions);
 await assert.rejects(()=>r.escrow.getCell('refund',0n),/exit_code: 9/);
 const pending=await r.escrow.getCell('pending',0n),trace=failureTrace(failed,r.escrowWallet.address,r.wallet.address);
 const evidence=(await observeFailedTransfer(r.client,r.asset,r.escrow.address,0n,250n,trace)).evidence;
 const [sa,sb]=quorumSign(failureDigest(r.escrow.address,r.domain,0n,evidence,pending));
 assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),failureBody(0n,evidence,0,2,sa,sb)),r.escrow.address),0);
 const record=(await r.escrow.getCell('refund',0n)).beginParse();assert.equal(record.loadCoins(),250n);assert(record.loadAddress().equals(r.user.address));
 assert.equal(await r.escrow.getNumber('locked'),0n);
 await restore();await r.escrow.send(r.attacker.getSender(),refundBody(0n));
 assert.equal(await r.balance(r.wallet),10000n);assert.equal(await r.balance(r.escrowWallet),0n);
});

test('standard escrow: a release rejected downstream is restored only by quorum over the exact bounce trace',async()=>{
 const r=await route(1000n),send=async(body:Cell)=>exitOf(await r.escrow.send(r.attacker.getSender(),body),r.escrow.address);
 await r.wallet.send(r.user.getSender(),transferBody(1n,1000n,r.escrow.address,r.user.address,Buffer.alloc(32,8)));assert.equal(await r.escrow.getNumber('locked'),1000n);
 const restore=await r.setBalance(r.wallet.address,r.user.address,(1n<<120n)-1n);
 const failedId=Buffer.alloc(32,10),failedBody=r.release(failedId,100n,r.user.address);
 const result=await r.escrow.send(r.attacker.getSender(),failedBody);r.setHistory(result.transactions);
 // Locked drops when the release is sent; the bounce alone does not restore it.
 assert.equal(await r.escrow.getNumber('locked'),900n);const pending=await r.escrow.getCell('pending',0n);
 const trace=failureTrace(result,r.escrowWallet.address,r.wallet.address);
 const observation=await observeFailedTransfer(r.client,r.asset,r.escrow.address,0n,100n,trace);
 await assert.rejects(()=>observeFailedTransfer(r.client,r.asset,r.escrow.address,1n,100n,trace),/mismatch/);
 await assert.rejects(()=>observeFailedTransfer(r.client,r.asset,r.escrow.address,0n,101n,trace),/mismatch/);
 await assert.rejects(()=>observeFailedTransfer(r.client,r.asset,r.escrow.address,0n,100n,{...trace,bounce:trace.source}),/Not a successful|participants/);
 const digest=failureDigest(r.escrow.address,r.domain,0n,observation.evidence,pending),[sa,sb]=quorumSign(digest);
 assert.equal(await send(failureBody(0n,Buffer.alloc(32,1),0,2,sa,sb)),407);assert.equal(await r.escrow.getNumber('locked'),900n);
 const recover=failureBody(0n,observation.evidence,0,2,sa,sb);
 assert.equal(await send(recover),0);assert.equal(await r.escrow.getNumber('locked'),1000n);
 // The pending entry is consumed, so a replayed restoration finds nothing to restore.
 assert.equal(await send(recover),9);assert.equal(await r.escrow.getNumber('locked'),1000n);
 // Restoration clears the release's replay mark, so the same release is paid once the wallet accepts it.
 await restore();assert.equal(await send(failedBody),0);
 assert.equal(await r.escrow.getNumber('locked'),900n);assert.equal(await r.balance(r.wallet),9000n+100n);
});

test('standard escrow: unrecorded credits are refunded to their sender once, by quorum, from exact traces',async()=>{
 const r=await route(1000n),to=Buffer.alloc(32,9);
 const credit=(res:Sent)=>res.transactions.find(t=>t.address===accountId(r.escrowWallet.address)&&t.inMessage?.info.type==='internal')!;
 const handled=(res:Sent)=>res.transactions.find(t=>t.address===accountId(r.escrow.address));
 // Skipped compute (1 nanoton), out of gas (0.0001 TON) and no notification at all (zero forward).
 const cases:[bigint,bigint][]=[[1n,10n],[100_000n,20n],[0n,30n]];let id=0n;
 for(const [forward,amount] of cases){
  const res=await r.wallet.send(r.user.getSender(),rawTransfer({query:forward+1n,amount,to:r.escrow.address,response:r.user.address,forward,recipient:to}));r.setHistory(res.transactions);
  assert.equal(await r.escrow.getNumber('locked'),0n);assert.equal(await r.escrow.getNumber('refundCount'),id);
  const h=handled(res),trace=forward===0n?{credit:txLocator(credit(res))}:{credit:txLocator(credit(res)),notification:txLocator(h!)};
  assert.equal(forward===0n,h===undefined);
  const seen=await observeUnrecordedCredit(r.client,r.asset,r.escrow.address,trace);
  assert.equal(seen.amount,amount);assert(seen.from.equals(r.user.address));
  if(forward>0n)await assert.rejects(()=>observeUnrecordedCredit(r.client,r.asset,r.escrow.address,{credit:trace.credit}),/required/);
  // A forged amount is rejected by signature; the genuine attestation records one refund.
  const d=unrecordedDigest(r.escrow.address,r.domain,seen.evidence,amount,r.user.address),[sa,sb]=quorumSign(d);
  assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),unrecordedBody(seen.evidence,amount+1n,r.user.address,0,2,sa,sb)),r.escrow.address),407);
  const body=unrecordedBody(seen.evidence,amount,r.user.address,0,2,sa,sb);
  assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),body),r.escrow.address),0);
  assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),body),r.escrow.address),406);
  assert.equal(await r.escrow.getNumber('recovered',BigInt('0x'+seen.evidence.toString('hex'))),1n);
  await r.escrow.send(r.attacker.getSender(),refundBody(id));id++;
 }
 assert.equal(await r.balance(r.escrowWallet),0n);assert.equal(await r.balance(r.wallet),10000n);
 // A recorded deposit is never treated as unrecorded.
 const recorded=await r.wallet.send(r.user.getSender(),transferBody(50n,40n,r.escrow.address,r.user.address,to),DEPOSIT_ATTACHED_TON);r.setHistory(recorded.transactions);
 await assert.rejects(()=>observeUnrecordedCredit(r.client,r.asset,r.escrow.address,{credit:txLocator(credit(recorded)),notification:txLocator(handled(recorded)!)}),/processed the notification/);
 assert.equal(await r.escrow.getNumber('locked'),40n);
});

test('standard escrow: a deposit above the uint64 ledger becomes an exact, caller-funded refund',async()=>{
 const r=await route(1000n),big=await r.chain.treasury('whale'),max=(1n<<64n)-1n;
 for(let i=0;i<2;i++)await r.master.send(r.owner.getSender(),referenceMintBody(big.address,max,BigInt(i)));
 const whale=r.chain.openContract(referenceWallet(big.address,r.master.address,r.wc));
 assert.equal(await r.balance(whale),2n*max);
 const body=rawTransfer({query:1n,amount:max+1n,to:r.escrow.address,response:big.address,recipient:Buffer.alloc(32,9)});
 const res=await whale.send(big.getSender(),body,DEPOSIT_ATTACHED_TON);assert.equal(exitOf(res,r.escrow.address),0);
 // Recorded like any other invalid deposit; the escrow spends none of its own TON on it.
 assert.equal(await r.escrow.getNumber('locked'),0n);assert.equal(await r.escrow.getNumber('refundCount'),1n);
 const record=(await r.escrow.getCell('refund',0n)).beginParse();assert.equal(record.loadCoins(),max+1n);assert(record.loadAddress().equals(big.address));
 assert.equal(await r.balance(r.escrowWallet),max+1n);
 // Repeated oversized or malformed deposits cannot drain the escrow's TON: each is paid
 // for by its own notification and only adds a refund record; nothing is sent out.
 for(let i=2;i<8;i++)await r.master.send(r.owner.getSender(),referenceMintBody(big.address,max,BigInt(i)));
 const ton=async()=>(await r.chain.getContract(r.escrow.address)).balance,before=await ton();
 for(let i=0;i<3;i++){
  await whale.send(big.getSender(),rawTransfer({query:BigInt(10+i),amount:max+1n,to:r.escrow.address,response:big.address,recipient:Buffer.alloc(32,9)}),DEPOSIT_ATTACHED_TON);
  await r.wallet.send(r.user.getSender(),rawTransfer({query:BigInt(20+i),amount:1n,to:r.escrow.address,response:r.user.address}),DEPOSIT_ATTACHED_TON);
 }
 assert.equal(await r.escrow.getNumber('refundCount'),7n);assert(await ton()>=before,'invalid deposits must not cost the escrow TON');
 // Even with an empty escrow balance the refund is paid, because its caller funds it.
 const account=(await r.chain.getContract(r.escrow.address)).account;account.account!.storage.balance.coins=0n;await r.chain.setShardAccount(r.escrow.address,account);
 assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),refundBody(0n)),r.escrow.address),0);
 // The first oversized deposit is back with its sender; the rest stay recorded for refund.
 assert.equal(await r.balance(whale),8n*max-3n*(max+1n));assert.equal(await r.balance(r.escrowWallet),3n*(max+1n)+3n);
});

test('standard escrow: an unrecorded credit whose excess TON returns to the escrow is still recoverable',async()=>{
 // The jetton wallet sends `excesses` to the response address; when that is the escrow,
 // it must not be mistaken for a transfer notification.
 const r=await route(1000n),credit=(res:Sent)=>res.transactions.find(t=>t.address===accountId(r.escrowWallet.address)&&t.inMessage?.info.type==='internal')!;
 const res=await r.wallet.send(r.user.getSender(),rawTransfer({query:7n,amount:50n,to:r.escrow.address,response:r.escrow.address,forward:0n,recipient:Buffer.alloc(32,9)}));r.setHistory(res.transactions);
 assert.equal(await r.escrow.getNumber('refundCount'),0n);assert.equal(await r.balance(r.escrowWallet),50n);
 const seen=await observeUnrecordedCredit(r.client,r.asset,r.escrow.address,{credit:txLocator(credit(res))});
 assert.equal(seen.amount,50n);assert(seen.from.equals(r.user.address));
});

test('standard escrow: a masterchain owner can deposit, and releases to the escrow itself are refused',async()=>{
 const r=await route(1000n),mc=await r.chain.treasury('mc-owner',{workchain:-1});
 await r.master.send(r.owner.getSender(),referenceMintBody(mc.address,500n,9n));
 // A masterchain owner's jetton wallet still lives on basechain.
 const got=await r.chain.runGetMethod(r.master.address,'get_wallet_address',[{type:'slice',cell:beginCell().storeAddress(mc.address).endCell()}]);
 const mcWallet=got.stackReader.readAddress();assert.equal(mcWallet.workChain,0);
 const res=await mc.send({to:mcWallet,value:DEPOSIT_ATTACHED_TON,body:transferBody(1n,300n,r.escrow.address,mc.address,Buffer.alloc(32,9))});
 assert.equal(exitOf(res,r.escrow.address),0);assert.equal(await r.escrow.getNumber('locked'),300n);assert.equal(await r.escrow.getNumber('depositCount'),1n);
 // Paying the escrow or its own jetton wallet would loop backing into self-refunds.
 for(const to of [r.escrow.address,r.escrowWallet.address])assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),r.release(Buffer.alloc(32,5),200n,to)),r.escrow.address),412);
 assert.equal(await r.escrow.getNumber('locked'),300n);assert.equal(await r.escrow.getNumber('refundCount'),0n);
});

/** Committee slot `i` named twice with the same (valid) signature: no TS encoder emits this. */
const oneKeyQuorum=(b:Builder,i:number,sig:Buffer)=>b.storeUint(i,8).storeUint(i,8).storeRef(beginCell().storeBuffer(sig).endCell()).storeRef(beginCell().storeBuffer(sig).endCell()).endCell();

test('standard escrow: one committee key signing twice is not a recovery quorum',async()=>{
 const r=await route(1000n),send=async(body:Cell)=>exitOf(await r.escrow.send(r.attacker.getSender(),body),r.escrow.address),ev=Buffer.alloc(32,7);
 // Unrecorded-credit refund: key 1 alone would mint a refund claim on escrowed backing.
 const [u]=quorumSign(unrecordedDigest(r.escrow.address,r.domain,ev,500n,r.attacker.address),1,2);
 assert.equal(await send(oneKeyQuorum(beginCell().storeUint(OP.refundUnrecorded,32).storeBuffer(ev).storeCoins(500n).storeAddress(r.attacker.address),1,u)),404);
 assert.equal(await r.escrow.getNumber('refundCount'),0n);assert.equal(await r.escrow.getNumber('recovered',BigInt('0x'+ev.toString('hex'))),0n);
 // Failed-transfer restoration: a real pending release whose payout bounced downstream.
 await r.wallet.send(r.user.getSender(),transferBody(1n,1000n,r.escrow.address,r.user.address,Buffer.alloc(32,8)));
 await r.setBalance(r.wallet.address,r.user.address,(1n<<120n)-1n);await r.escrow.send(r.attacker.getSender(),r.release(Buffer.alloc(32,10),100n,r.user.address));
 const pending=await r.escrow.getCell('pending',0n),d=failureDigest(r.escrow.address,r.domain,0n,ev,pending),[f]=quorumSign(d,1,2);
 assert.equal(await send(oneKeyQuorum(beginCell().storeUint(OP.restoreFailed,32).storeUint(0n,64).storeBuffer(ev),1,f)),404);
 assert.equal(await r.escrow.getNumber('locked'),900n);assert((await r.escrow.getCell('pending',0n)).equals(pending));
 // The same signature paired with a second key is accepted, so only the distinct-key check stood in the way.
 const [fa,fb]=quorumSign(d,0,1);assert.equal(await send(failureBody(0n,ev,0,1,fa,fb)),0);assert.equal(await r.escrow.getNumber('locked'),1000n);
});

test('standard escrow: a release signature binds escrow, receipt, amount and domain',async()=>{
 const r=await route(1000n),send=async(to:typeof r.escrow,body:Cell)=>exitOf(await to.send(r.attacker.getSender(),body),to.address),id=Buffer.alloc(32,3);
 await r.wallet.send(r.user.getSender(),transferBody(1n,500n,r.escrow.address,r.user.address,Buffer.alloc(32,9)));
 // A twin escrow for the same jetton, committee and domain (only its cap differs).
 const twin=r.chain.openContract(TonContract.create(r.ec,escrowData(r.domain,TON_COMMITTEE,r.master.address,r.wc,999n)));await twin.send(r.owner.getSender());
 await r.wallet.send(r.user.getSender(),transferBody(2n,500n,twin.address,r.user.address,Buffer.alloc(32,9)));assert.equal(await twin.getNumber('locked'),500n);
 const [sa,sb]=quorumSign(releaseDigest(r.escrow.address,r.domain,id,100n,r.user.address));
 assert.equal(await send(twin,releaseBody(id,100n,r.user.address,0,2,sa,sb)),407);assert.equal(await twin.getNumber('locked'),500n);
 assert.equal(await send(r.escrow,releaseBody(Buffer.alloc(32,4),100n,r.user.address,0,2,sa,sb)),407);
 assert.equal(await send(r.escrow,releaseBody(id,200n,r.user.address,0,2,sa,sb)),407);
 const [da,db]=quorumSign(releaseDigest(r.escrow.address,Buffer.alloc(32,1),id,100n,r.user.address));
 assert.equal(await send(r.escrow,releaseBody(id,100n,r.user.address,0,2,da,db)),407);
 assert.equal(await r.escrow.getNumber('locked'),500n);assert.equal(await r.escrow.getNumber('nextRelease'),0n);
 assert.equal(await send(r.escrow,releaseBody(id,100n,r.user.address,0,2,sa,sb)),0);assert.equal(await r.escrow.getNumber('locked'),400n);
});

test('standard escrow: an unrecorded-credit attestation binds its sender and evidence',async()=>{
 const r=await route(1000n),send=async(body:Cell)=>exitOf(await r.escrow.send(r.attacker.getSender(),body),r.escrow.address),ev=Buffer.alloc(32,7);
 const [sa,sb]=quorumSign(unrecordedDigest(r.escrow.address,r.domain,ev,5n,r.user.address));
 assert.equal(await send(unrecordedBody(ev,5n,r.attacker.address,0,2,sa,sb)),407);
 assert.equal(await send(unrecordedBody(Buffer.alloc(32,8),5n,r.user.address,0,2,sa,sb)),407);
 assert.equal(await r.escrow.getNumber('refundCount'),0n);assert.equal(await r.escrow.getNumber('recovered',BigInt('0x'+ev.toString('hex'))),0n);
 assert.equal(await send(unrecordedBody(ev,5n,r.user.address,0,2,sa,sb)),0);
 const record=(await r.escrow.getCell('refund',0n)).beginParse();assert.equal(record.loadCoins(),5n);assert(record.loadAddress().equals(r.user.address));
});

test('standard escrow: a transfer bounced by its own jetton wallet restores the release; other bounces do not',async()=>{
 const r=await route(1000n),id=Buffer.alloc(32,3),receipt=BigInt('0x'+id.toString('hex'));
 await r.wallet.send(r.user.getSender(),transferBody(1n,500n,r.escrow.address,r.user.address,Buffer.alloc(32,9)));
 // The escrow's wallet holds less than the release, so it rejects the Transfer back to the escrow.
 const restore=await r.setBalance(r.escrowWallet.address,r.escrow.address,10n),body=r.release(id,100n,r.user.address);
 const res=await r.escrow.send(r.attacker.getSender(),body);
 const back=res.transactions.filter(t=>t.address===accountId(r.escrow.address)&&t.inMessage?.info.type==='internal'&&t.inMessage.info.bounced);
 assert.equal(back.length,1);assert.equal(exitOf({transactions:back},r.escrow.address),0);
 assert.equal(await r.escrow.getNumber('locked'),500n);assert.equal(await r.escrow.getNumber('releaseState',receipt),0n);
 await assert.rejects(()=>r.escrow.getCell('pending',0n),/exit_code: 9/);assert.equal(await r.escrow.getNumber('nextRelease'),1n);
 // Once the wallet can pay, the same signed release goes through exactly once.
 await restore();assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),body),r.escrow.address),0);
 assert.equal(await r.escrow.getNumber('locked'),400n);assert.equal(await r.balance(r.wallet),9500n+100n);
 // A pending release left by a downstream rejection, then a forged bounce of its Transfer.
 await r.setBalance(r.wallet.address,r.user.address,(1n<<120n)-1n);await r.escrow.send(r.attacker.getSender(),r.release(Buffer.alloc(32,4),100n,r.user.address));
 assert.equal(await r.escrow.getNumber('locked'),300n);const pending=await r.escrow.getCell('pending',2n);
 const bounced=beginCell().storeUint(OP.bounced,32).storeUint(OP.jettonTransfer,32).storeUint(2n,64).storeCoins(100n).endCell();
 const bounce=(from:Address)=>r.chain.sendMessage(internal({from,to:r.escrow.address,value:toNano('0.05'),bounced:true,bounce:false,body:bounced}));
 assert.equal(exitOf(await bounce(r.attacker.address),r.escrow.address),401);
 assert.equal(await r.escrow.getNumber('locked'),300n);assert((await r.escrow.getCell('pending',2n)).equals(pending));
 // The identical bounce from the escrow's wallet does restore, so only the sender check refused it.
 assert.equal(exitOf(await bounce(r.escrowWallet.address),r.escrow.address),0);assert.equal(await r.escrow.getNumber('locked'),400n);
});

test('standard escrow: zero-amount deposits are refused and an empty forward payload becomes a refund',async()=>{
 const r=await route(1000n),to=Buffer.alloc(32,9),send=async(body:Cell)=>exitOf(await r.wallet.send(r.user.getSender(),body,DEPOSIT_ATTACHED_TON),r.escrow.address);
 const state=async()=>[await r.escrow.getNumber('locked'),await r.escrow.getNumber('depositCount'),await r.escrow.getNumber('refundCount')];
 assert.equal(await send(rawTransfer({query:1n,amount:0n,to:r.escrow.address,response:r.user.address,recipient:to})),402);assert.deepEqual(await state(),[0n,0n,0n]);
 // Sender wallets always emit the Either bit; a minter can notify with no payload bits at all.
 const notify=beginCell().storeUint(OP.internalTransfer,32).storeUint(2n,64).storeCoins(50n).storeAddress(r.user.address).storeAddress(null).storeCoins(DEPOSIT_FORWARD_TON).endCell();
 const minted=await r.master.send(r.owner.getSender(),beginCell().storeUint(OP.referenceMint,32).storeUint(2n,64).storeAddress(r.escrow.address).storeCoins(100_000_000n).storeRef(notify).endCell());
 assert.equal(exitOf(minted,r.escrow.address),0);assert.deepEqual(await state(),[0n,0n,1n]);
 // An Either-left payload with no recipient is a refund too, never a deposit for recipient 0.
 assert.equal(await send(transferBody(3n,60n,r.escrow.address,r.user.address)),0);assert.deepEqual(await state(),[0n,0n,2n]);
 for(const [id,amount] of [[0n,50n],[1n,60n]] as const){const rec=(await r.escrow.getCell('refund',id)).beginParse();assert.equal(rec.loadCoins(),amount);assert(rec.loadAddress().equals(r.user.address));}
 for(const id of [0n,1n])await r.escrow.send(r.attacker.getSender(),refundBody(id));
 assert.equal(await r.balance(r.wallet),10000n+50n);
});

test('escrowData rejects a committee that repeats a key',()=>{
 const [k0,,k2]=TON_COMMITTEE as [Buffer,Buffer,Buffer];
 assert.throws(()=>escrowData(STANDARD_DOMAIN,[k0,k0,k2],new Address(0,Buffer.alloc(32,1)),Cell.EMPTY),/invalid domain\/committee/);
});
