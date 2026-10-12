import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Address,beginCell,Cell,toNano,TupleReader,type Transaction} from '@ton/core';
import {OP,transferBody,releaseDigest,releaseBody,refundBody,DEPOSIT_ATTACHED_TON} from '../src/ton.js';
import {referenceWallet,referenceMintBody,validateAssets,verifyAsset,failureDigest,failureBody,unrecordedDigest,unrecordedBody} from '../src/jettons.js';
import {observeFailedTransfer,observeUnrecordedCredit,txLocator} from '../src/ton-traces.js';
import {quorumSign,accountId,exitOf,rawTransfer} from './helpers/ton.js';
import {route} from './helpers/standard-route.js';

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
 const record=(await r.escrow.getCell('refund',0n)).beginParse();assert.equal(record.loadUintBig(64),250n);assert(record.loadAddress().equals(r.user.address));
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

test('standard escrow: a deposit above the uint64 ledger is returned immediately',async()=>{
 const r=await route(1000n),big=await r.chain.treasury('whale'),max=(1n<<64n)-1n;
 for(let i=0;i<2;i++)await r.master.send(r.owner.getSender(),referenceMintBody(big.address,max,BigInt(i)));
 const whale=r.chain.openContract(referenceWallet(big.address,r.master.address,r.wc));
 assert.equal(await r.balance(whale),2n*max);
 const body=rawTransfer({query:1n,amount:max+1n,to:r.escrow.address,response:big.address,recipient:Buffer.alloc(32,9)});
 const ton=async(a:Address)=>(await r.chain.getContract(a)).balance,escrowBefore=await ton(r.escrow.address),whaleBefore=await ton(big.address);
 const res=await whale.send(big.getSender(),body,DEPOSIT_ATTACHED_TON);assert.equal(exitOf(res,r.escrow.address),0);
 // The escrow funds the return and recovers its unused TON: the sender gains nothing,
 // so oversized deposits cannot be looped to siphon the escrow's balance.
 assert(escrowBefore-(await ton(r.escrow.address))<toNano('0.03'),'escrow loses at most fees');
 assert(await ton(big.address)<whaleBefore,'sender cannot profit from the escrow-funded return');
 // Credited to the escrow wallet, then sent straight back to the sender.
 assert.equal(res.transactions.filter(t=>t.address===accountId(r.escrowWallet.address)).length,2);
 assert.equal(await r.balance(whale),2n*max);assert.equal(await r.balance(r.escrowWallet),0n);
 assert.equal(await r.escrow.getNumber('locked'),0n);assert.equal(await r.escrow.getNumber('refundCount'),0n);
});
