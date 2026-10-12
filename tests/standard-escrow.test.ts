import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Blockchain,type SandboxContract,type TreasuryContract} from '@ton/sandbox';
import {Address,beginCell,Cell,toNano,TupleReader,type Transaction} from '@ton/core';
import {keyPairFromSeed} from '@ton/crypto';
import type {TonClient4} from '@ton/ton';
import {createConstructorContext,createCircuitContext,sampleContractAddress,type CircuitContext} from '@midnight-ntwrk/compact-runtime';
import {Contract as MidnightContract,ledger} from '../build/midnight/contract/index.js';
import {compileTon} from '../scripts/compile-ton.js';
import {TonContract,escrowData,transferBody,releaseDigest,releaseBody,signRelease,refundBody,DEPOSIT_ATTACHED_TON} from '../src/ton.js';
import {referenceWallet,referenceMintBody,failureDigest,failureBody,unrecordedDigest,unrecordedBody,type JettonAsset} from '../src/jettons.js';
import {observeFailedTransfer,observeUnrecordedCredit} from '../src/ton-recovery.js';
import {observeTon} from '../src/receipts.js';
import {retirementRelease} from '../src/redemptions.js';
import {verifyJettonDelivery} from '../src/ton-finality.js';
import {BridgeClient} from '../src/sdk.js';
import {verifyingKey,signClaim,witnesses} from '../src/midnight.js';
import {TON_TESTNET_ZERO_STATE} from '../src/ton-network.js';

const compiled=new Map<string,Promise<Cell>>();
const code=(n:string)=>{if(!compiled.has(n))compiled.set(n,compileTon(n).then(r=>Cell.fromBase64(r.codeBoc64)));return compiled.get(n)!;};
const keys=[1,2,3].map(n=>keyPairFromSeed(Buffer.alloc(32,n))),domain=Buffer.alloc(32,77);
const accountId=(a:Address)=>BigInt('0x'+a.hash.toString('hex'));
type Sent={transactions:Transaction[]};
/** Compute exit code of the escrow transaction a message produced. */
const exitOf=(r:Sent,escrow:Address)=>{const tx=r.transactions.find(t=>t.address===accountId(escrow));const d=tx?.description;return d?.type==='generic'&&d.computePhase.type==='vm'?d.computePhase.exitCode:d?.type==='generic'?'skipped':'absent';};

async function route(cap=1000n){
 const [wc,mc,ec]=await Promise.all([code('reference-wallet'),code('reference-minter'),code('escrow-standard')]);
 const chain=await Blockchain.create(),owner=await chain.treasury('owner'),user=await chain.treasury('user'),attacker=await chain.treasury('attacker');
 const master=chain.openContract(TonContract.create(mc,beginCell().storeCoins(0).storeAddress(owner.address).storeRef(Cell.EMPTY).storeRef(wc).endCell()));await master.send(owner.getSender());
 const escrow=chain.openContract(TonContract.create(ec,escrowData(domain,keys.map(k=>k.publicKey),master.address,wc,cap)));await escrow.send(owner.getSender());
 await master.send(owner.getSender(),referenceMintBody(user.address,10000n));
 const wallet=chain.openContract(referenceWallet(user.address,master.address,wc)),escrowWallet=chain.openContract(referenceWallet(escrow.address,master.address,wc));
 const asset:JettonAsset={asset:0,symbol:'TOKEN',decimals:6,master:master.address.toRawString(),masterCodeHash:mc.hash().toString('hex'),walletCodeBoc:wc.toBoc().toString('base64'),walletCodeHash:wc.hash().toString('hex'),cap:cap.toString(),adapter:'tep74-reference'};
 let history:Transaction[]=[];
 // Sandbox-backed stand-in for a trusted TON v4 RPC; every read is the latest state.
 const client={getLastBlock:async()=>({last:{seqno:20},init:{rootHash:TON_TESTNET_ZERO_STATE},now:Date.now()/1000}),
  getAccount:async(_b:number,address:Address)=>{const a=(await chain.getContract(address)).account.account?.storage.state;return {account:{state:a?.type==='active'?{type:'active',code:a.state.code!.toBoc().toString('base64'),data:a.state.data!.toBoc().toString('base64')}:{type:'uninit'}}};},
  runMethod:async(_b:number,address:Address,name:string,args:any[]=[])=>{try{const r=await chain.runGetMethod(address,name,args);return {exitCode:r.exitCode,reader:new TupleReader(r.stack),block:{rootHash:'sandbox'}};}catch{return {exitCode:9,reader:new TupleReader([]),block:{rootHash:'sandbox'}};}},
  getAccountLite:async()=>({account:{last:{lt:'99999999999999',hash:Buffer.alloc(32).toString('base64')}}}),
  getAccountTransactions:async(address:Address)=>history.filter(tx=>tx.address===accountId(address)).map(tx=>({tx}))} as unknown as TonClient4;
 const balance=async(w:SandboxContract<TonContract>)=>w.getNumber('get_wallet_data');
 const release=(id:Buffer,amount:bigint,to:Address,a=0,b=2)=>{const d=releaseDigest(escrow.address,domain,id,amount,to);return releaseBody(id,amount,to,a,b,signRelease(d,keys[a]!.secretKey),signRelease(d,keys[b]!.secretKey));};
 const setBalance=async(w:Address,owner:Address,amount:bigint)=>{const s=(await chain.getContract(w)).account;assert(s.account?.storage.state.type==='active');const original=s.account.storage.state.state.data;
  s.account.storage.state.state.data=beginCell().storeCoins(amount).storeAddress(owner).storeAddress(master.address).storeRef(wc).endCell();await chain.setShardAccount(w,s);
  return async()=>{const r=(await chain.getContract(w)).account;assert(r.account?.storage.state.type==='active');r.account.storage.state.state.data=original;await chain.setShardAccount(w,r);};};
 return {chain,owner,user,attacker,master,escrow,wallet,escrowWallet,asset,client,balance,release,setBalance,ec,setHistory:(h:Transaction[])=>{history=h;}};
}

test('standard escrow: capacity refunds, payload forms, excesses and unknown operations',async()=>{
 const r=await route(1000n),to=Buffer.alloc(32,9);
 // Recipient carried in a reference (Either right) is accepted like the inline form.
 const inRef=beginCell().storeUint(0x0f8a7ea5,32).storeUint(1,64).storeCoins(300).storeAddress(r.escrow.address).storeAddress(r.user.address).storeBit(false).storeCoins(toNano('0.01')).storeBit(true).storeRef(beginCell().storeBuffer(to).endCell()).endCell();
 await r.wallet.send(r.user.getSender(),inRef);assert.equal(await r.escrow.getNumber('locked'),300n);
 await r.wallet.send(r.user.getSender(),transferBody(2n,600n,r.escrow.address,r.user.address,to));assert.equal(await r.escrow.getNumber('locked'),900n);
 // Over the remaining capacity, over the per-escrow cap, and a malformed recipient all become exact refunds.
 await r.wallet.send(r.user.getSender(),transferBody(3n,101n,r.escrow.address,r.user.address,to));
 await r.wallet.send(r.user.getSender(),transferBody(4n,1001n,r.escrow.address,r.user.address,to));
 const extraBits=beginCell().storeUint(0x0f8a7ea5,32).storeUint(5,64).storeCoins(7).storeAddress(r.escrow.address).storeAddress(r.user.address).storeBit(false).storeCoins(toNano('0.01')).storeBit(false).storeBuffer(to).storeBit(true).endCell();
 await r.wallet.send(r.user.getSender(),extraBits);
 assert.equal(await r.escrow.getNumber('locked'),900n);assert.equal(await r.escrow.getNumber('depositCount'),2n);assert.equal(await r.escrow.getNumber('refundCount'),3n);
 assert.equal(await r.balance(r.escrowWallet),900n+101n+1001n+7n);
 for(const id of [0n,1n,2n])await r.escrow.send(r.attacker.getSender(),refundBody(id));
 assert.equal(await r.balance(r.escrowWallet),900n);assert.equal(await r.balance(r.wallet),10000n-900n);
 // Returned TON from the jetton wallet is accepted silently; unknown operations bounce.
 const excess=await r.escrow.send(r.attacker.getSender(),beginCell().storeUint(0xd53276db,32).storeUint(0,64).endCell());assert.equal(exitOf(excess,r.escrow.address),0);
 const unknown=await r.escrow.send(r.attacker.getSender(),beginCell().storeUint(0x12345678,32).endCell());assert.equal(exitOf(unknown,r.escrow.address),400);
 const topUp=await r.escrow.send(r.attacker.getSender(),Cell.EMPTY);assert.equal(exitOf(topUp,r.escrow.address),0);
 // A refund needs enough TON to pay for the outgoing jetton transfer.
 assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),refundBody(0n),toNano('0.1')),r.escrow.address),403);
});

test('standard escrow: release guards fail closed',async()=>{
 const r=await route(1000n),id=Buffer.alloc(32,3);
 await r.wallet.send(r.user.getSender(),transferBody(1n,500n,r.escrow.address,r.user.address,Buffer.alloc(32,9)));
 const ok=r.release(id,100n,r.user.address);
 assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),ok,toNano('0.1')),r.escrow.address),403);
 assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),r.release(Buffer.alloc(32,4),501n,r.user.address)),r.escrow.address),405);
 // Same signer twice and a signature from the wrong committee slot.
 const d=releaseDigest(r.escrow.address,domain,id,100n,r.user.address),sig=signRelease(d,keys[0]!.secretKey);
 const dup=beginCell().storeUint(0x42524701,32).storeBuffer(id).storeUint(100n,64).storeAddress(r.user.address).storeUint(1,8).storeUint(1,8).storeRef(beginCell().storeBuffer(sig).endCell()).storeRef(beginCell().storeBuffer(sig).endCell()).endCell();
 assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),dup),r.escrow.address),404);
 const wrongSlot=releaseBody(id,100n,r.user.address,0,1,sig,signRelease(d,keys[2]!.secretKey));
 assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),wrongSlot),r.escrow.address),408);
 // Signatures do not transfer to another recipient or amount.
 const redirected=releaseBody(id,100n,r.attacker.address,0,2,sig,signRelease(d,keys[2]!.secretKey));
 assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),redirected),r.escrow.address),407);
 const masterchain=new Address(-1,Buffer.alloc(32,5)),md=releaseDigest(r.escrow.address,domain,id,100n,r.user.address);
 const toMasterchain=beginCell().storeUint(0x42524701,32).storeBuffer(id).storeUint(100n,64).storeAddress(masterchain).storeUint(0,8).storeUint(2,8).storeRef(beginCell().storeBuffer(signRelease(md,keys[0]!.secretKey)).endCell()).storeRef(beginCell().storeBuffer(signRelease(md,keys[2]!.secretKey)).endCell()).endCell();
 assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),toMasterchain),r.escrow.address),411);
 assert.equal(await r.escrow.getNumber('locked'),500n);
 assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),ok),r.escrow.address),0);
 assert.equal(await r.escrow.getNumber('locked'),400n);assert.equal(await r.balance(r.wallet),9600n);
 assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),ok),r.escrow.address),406);
});

test('standard escrow: a refund rejected downstream is restored by quorum and paid on retry',async()=>{
 const r=await route(1000n);
 await r.wallet.send(r.user.getSender(),transferBody(1n,250n,r.escrow.address,r.user.address));
 assert.equal(await r.escrow.getNumber('refundCount'),1n);
 // The sender's wallet cannot accept the refund: its balance would overflow.
 const restore=await r.setBalance(r.wallet.address,r.user.address,(1n<<120n)-1n);
 const failed=await r.escrow.send(r.attacker.getSender(),refundBody(0n));r.setHistory(failed.transactions);
 await assert.rejects(()=>r.escrow.getCell('refund',0n));
 const pending=await r.escrow.getCell('pending',0n),src=r.escrowWallet.address;
 const find=(addr:Address,bounced:boolean)=>failed.transactions.find(tx=>tx.address===accountId(addr)&&tx.inMessage?.info.type==='internal'&&tx.inMessage.info.bounced===bounced)!;
 const loc=(tx:Transaction)=>({lt:tx.lt.toString(),hash:tx.hash().toString('hex')});
 const trace={source:loc(find(src,false)),rejection:loc(find(r.wallet.address,false)),bounce:loc(find(src,true)),recipientWallet:r.wallet.address.toRawString()};
 const evidence=(await observeFailedTransfer(r.client,r.asset,r.escrow.address,0n,250n,trace)).evidence;
 const digest=failureDigest(r.escrow.address,domain,0n,evidence,pending);
 await r.escrow.send(r.attacker.getSender(),failureBody(0n,evidence,0,2,signRelease(digest,keys[0]!.secretKey),signRelease(digest,keys[2]!.secretKey)));
 const record=(await r.escrow.getCell('refund',0n)).beginParse();assert.equal(record.loadUintBig(64),250n);assert(record.loadAddress().equals(r.user.address));
 assert.equal(await r.escrow.getNumber('locked'),0n);
 await restore();await r.escrow.send(r.attacker.getSender(),refundBody(0n));
 assert.equal(await r.balance(r.wallet),10000n);assert.equal(await r.balance(r.escrowWallet),0n);
});

test('standard escrow: unrecorded credits are refunded to their sender once, by quorum, from exact traces',async()=>{
 const r=await route(1000n),to=Buffer.alloc(32,9);
 const notify=(forward:bigint,amount:bigint,q:bigint)=>beginCell().storeUint(0x0f8a7ea5,32).storeUint(q,64).storeCoins(amount).storeAddress(r.escrow.address).storeAddress(r.user.address).storeBit(false).storeCoins(forward).storeBit(false).storeBuffer(to).endCell();
 const loc=(tx:Transaction)=>({lt:tx.lt.toString(),hash:tx.hash().toString('hex')});
 const credit=(res:Sent)=>res.transactions.find(t=>t.address===accountId(r.escrowWallet.address)&&t.inMessage?.info.type==='internal')!;
 const handled=(res:Sent)=>res.transactions.find(t=>t.address===accountId(r.escrow.address));
 const quorum=(evidence:Buffer,amount:bigint,from:Address)=>{const d=unrecordedDigest(r.escrow.address,domain,evidence,amount,from);return unrecordedBody(evidence,amount,from,0,2,signRelease(d,keys[0]!.secretKey),signRelease(d,keys[2]!.secretKey));};
 // Skipped compute (1 nanoton), out of gas (0.0001 TON) and no notification at all (zero forward).
 const cases:[bigint,bigint][]=[[1n,10n],[100_000n,20n],[0n,30n]];let id=0n;
 for(const [forward,amount] of cases){
  const res=await r.wallet.send(r.user.getSender(),notify(forward,amount,forward+1n));r.setHistory(res.transactions);
  assert.equal(await r.escrow.getNumber('locked'),0n);assert.equal(await r.escrow.getNumber('refundCount'),id);
  const h=handled(res),trace=forward===0n?{credit:loc(credit(res))}:{credit:loc(credit(res)),notification:loc(h!)};
  assert.equal(forward===0n,h===undefined);
  const seen=await observeUnrecordedCredit(r.client,r.asset,r.escrow.address,trace);
  assert.equal(seen.amount,amount);assert(seen.from.equals(r.user.address));
  if(forward>0n)await assert.rejects(()=>observeUnrecordedCredit(r.client,r.asset,r.escrow.address,{credit:trace.credit}),/required/);
  // A forged amount is rejected by signature; the genuine attestation records one refund.
  const d=unrecordedDigest(r.escrow.address,domain,seen.evidence,amount,r.user.address);
  const inflated=unrecordedBody(seen.evidence,amount+1n,r.user.address,0,2,signRelease(d,keys[0]!.secretKey),signRelease(d,keys[2]!.secretKey));
  assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),inflated),r.escrow.address),407);
  const body=quorum(seen.evidence,amount,r.user.address);
  assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),body),r.escrow.address),0);
  assert.equal(exitOf(await r.escrow.send(r.attacker.getSender(),body),r.escrow.address),406);
  assert.equal(await r.escrow.getNumber('recovered',BigInt('0x'+seen.evidence.toString('hex'))),1n);
  await r.escrow.send(r.attacker.getSender(),refundBody(id));id++;
 }
 assert.equal(await r.balance(r.escrowWallet),0n);assert.equal(await r.balance(r.wallet),10000n);
 // A recorded deposit is never treated as unrecorded.
 const recorded=await r.wallet.send(r.user.getSender(),transferBody(50n,40n,r.escrow.address,r.user.address,to),DEPOSIT_ATTACHED_TON);r.setHistory(recorded.transactions);
 await assert.rejects(()=>observeUnrecordedCredit(r.client,r.asset,r.escrow.address,{credit:loc(credit(recorded)),notification:loc(handled(recorded)!)}),/processed the notification/);
 assert.equal(await r.escrow.getNumber('locked'),40n);
});

test('standard escrow: a deposit above the uint64 ledger is returned immediately',async()=>{
 const r=await route(1000n),big=await r.chain.treasury('whale'),max=(1n<<64n)-1n;
 for(let i=0;i<2;i++)await r.master.send(r.owner.getSender(),referenceMintBody(big.address,max,BigInt(i)));
 const whale=r.chain.openContract(referenceWallet(big.address,r.master.address,Cell.fromBase64(r.asset.walletCodeBoc)));
 assert.equal(await r.balance(whale),2n*max);
 const body=beginCell().storeUint(0x0f8a7ea5,32).storeUint(1,64).storeCoins(max+1n).storeAddress(r.escrow.address).storeAddress(big.address).storeBit(false).storeCoins(toNano('0.01')).storeBit(false).storeBuffer(Buffer.alloc(32,9)).endCell();
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

test('standard route end to end: SDK deposit, observed receipt, Midnight claim, redemption, release and delivery',async()=>{
 const r=await route(1000n),midKeys=[11n,22n,33n],midAddress=sampleContractAddress();
 const midnight=new MidnightContract(witnesses),init=midnight.initialState(createConstructorContext({},'00'.repeat(32)),domain,midKeys.map(verifyingKey),1_000_000n);
 let ctx:CircuitContext<Record<string,never>>=createCircuitContext(midAddress,'00'.repeat(32),init.currentContractState,{});
 const other=TonContract.create(r.ec,escrowData(domain,keys.map(k=>k.publicKey),r.attacker.address,Cell.fromBase64(r.asset.walletCodeBoc),1000n)).address;
 const circuits=midnight.impureCircuits as unknown as Record<string,(c:typeof ctx,...a:unknown[])=>{context:typeof ctx}>;
 const bridge=new BridgeClient({network:'local',domain:domain.toString('hex'),midnightAddress:midAddress,escrows:[r.escrow.address.toRawString(),other.toRawString()],committee:midKeys.map(verifyingKey) as [any,any,any]},
  {call:async(circuit,args)=>{ctx=circuits[circuit]!(ctx,...args).context;return circuit;}});
 const midnightRecipient='ab'.repeat(32);
 await r.wallet.send(r.user.getSender(),bridge.depositMessage(0,700n,midnightRecipient,r.user.address.toRawString(),1n),DEPOSIT_ATTACHED_TON);
 const config={escrow:r.escrow.address.toRawString(),asset:0 as const,codeHash:r.ec.hash().toString('hex'),configHash:escrowData(domain,keys.map(k=>k.publicKey),r.master.address,Cell.fromBase64(r.asset.walletCodeBoc),1000n).beginParse().loadRef().hash().toString('hex'),confirmationDepth:3};
 const receipt=await observeTon(r.client,config,0n);
 assert.equal(receipt.amount,'700');assert.equal(receipt.recipient,midnightRecipient);
 await assert.rejects(()=>observeTon(r.client,{...config,configHash:'00'.repeat(32)},0n),/configuration/);
 await assert.rejects(()=>observeTon(r.client,config,1n),/not found/);
 const digest=bridge.claimDigest(receipt);
 await bridge.claim(receipt,[{signer:2,signature:signClaim(digest,midKeys[2]!)},{signer:1,signature:signClaim(digest,midKeys[1]!)}]);
 assert.equal(ledger(ctx.currentQueryContext.state).circulating[0],await r.escrow.getNumber('locked'));
 await assert.rejects(()=>bridge.claim(receipt,[{signer:0,signature:signClaim(digest,midKeys[0]!)},{signer:1,signature:signClaim(digest,midKeys[1]!)}]),/replayed receipt/);
 // Retire on Midnight, then derive the release only from the recorded commitment.
 const id='cd'.repeat(32);await bridge.redeem(id,0,300n,r.user.address.toRawString());
 const request={id,asset:0 as const,amount:'300',recipient:r.user.address.toRawString(),transactionId:'local'};
 const escrows:[string,string]=[r.escrow.address.toRawString(),other.toRawString()],data=ledger(ctx.currentQueryContext.state);
 assert.throws(()=>retirementRelease(data,domain.toString('hex'),{...request,amount:'301'},escrows),/differs/);
 assert.throws(()=>retirementRelease(data,domain.toString('hex'),{...request,recipient:r.attacker.address.toRawString()},escrows),/differs/);
 assert.throws(()=>retirementRelease(data,domain.toString('hex'),{...request,asset:1},escrows),/differs/);
 const releaseHash=retirementRelease(data,domain.toString('hex'),request,escrows);
 assert(releaseHash.equals(releaseDigest(r.escrow.address,domain,Buffer.from(id,'hex'),300n,r.user.address)));
 const delivered=await r.escrow.send(r.attacker.getSender(),releaseBody(Buffer.from(id,'hex'),300n,r.user.address,0,2,signRelease(releaseHash,keys[0]!.secretKey),signRelease(releaseHash,keys[2]!.secretKey)));
 r.setHistory(delivered.transactions);
 const proof=await verifyJettonDelivery(r.client,r.escrowWallet.address,r.wallet.address,0n,300n);assert.equal(proof.amount,'300');
 // Backing equals circulation once settled, and the token balance matches the ledger.
 assert.equal(ledger(ctx.currentQueryContext.state).circulating[0],400n);assert.equal(await r.escrow.getNumber('locked'),400n);assert.equal(await r.balance(r.escrowWallet),400n);
 assert.equal(await r.balance(r.wallet),10000n-400n);
});
