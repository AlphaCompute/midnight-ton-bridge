import {referenceWallet,referenceMintBody,verifyAsset} from '../src/jettons.js';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {Address,Cell,beginCell,internal,toNano} from '@ton/core';
import {keyPairFromSeed} from '@ton/crypto';
import {addressFromKey} from '@midnight-ntwrk/ledger-v8';
import {persistentHash,CompactTypeBytes} from '@midnight-ntwrk/compact-runtime';
import {syncWallet} from '@midnight-ntwrk/testkit-js';
import {network,statePath,readSecret} from '../src/environment.js';
import {openMidnight} from '../src/live-midnight.js';
import {openTon} from '../src/live-ton.js';
import {Journal} from '../src/journal.js';
import {jettonWallet,transferBody,releaseBody,signRelease} from '../src/ton.js';
import {observeTon} from '../src/receipts.js';
import {signClaim,quoteSwap} from '../src/midnight.js';
import {verifyRedemption,type MidnightPins} from '../src/redemptions.js';
import {verifyJettonDelivery} from '../src/ton-finality.js';
import {ledger,pureCircuits} from '../build/midnight/contract/index.js';
if(network()!=='preprod')throw new Error('Public testnets only');
const read=(n:string)=>JSON.parse(readFileSync(statePath(n),'utf8'));
const d=read('midnight-deployment.json') as {address:string;domain:string;pins:MidnightPins;network:string},plan=read('ton-plan.json');
if(d.network!=='preprod'||plan.network!=='ton-testnet'||d.domain!==plan.domain)throw new Error('deployment route mismatch');
const evidencePath=statePath('testnet-evidence.json'),resume=process.argv.includes('--resume');
if(existsSync(evidencePath)&&!resume)throw new Error('Prior testnet attempt exists. Reconcile its journals (reconcile:ton, reconcile), then continue it with --resume.');
if(!existsSync(evidencePath)&&resume)throw new Error('No prior attempt to resume');
const ops=readSecret<{midnight:string;tonSeed:string}[]>(statePath('demo-operators.json'));
const evidence:any=resume?JSON.parse(readFileSync(evidencePath,'utf8')):{network:'TON-testnet/Midnight-preprod',custody:'single developer host; synthetic assets only',midnight:d.address,ton:plan.assets,steps:[]};
if(evidence.complete)throw new Error('Demonstration already complete');
const save=()=>writeFileSync(evidencePath,JSON.stringify(evidence,(_,v)=>typeof v==='bigint'?v.toString():v,2));
// A step is done once its evidence is saved. On --resume, finished steps are skipped and
// their recorded results reused; nothing that already executed is sent again.
const keyOf=(step:any,seen:Map<string,number>)=>{
 if(step.circuit){const n=seen.get(step.circuit)??0;seen.set(step.circuit,n+1);return `${step.circuit}:${n}`;}
 if(step.deposit)return `receipt:${step.deposit.asset}`;
 return String(step.id).replace(/#\d+$/,'');
};
const done=()=>{const seen=new Map<string,number>(),out=new Map<string,any>();for(const step of evidence.steps)out.set(keyOf(step,seen),step);return out;};
const ton=new Journal(statePath('ton-transactions.sqlite'));
/** Sends once per logical ID. A confirmed earlier attempt counts as done; only a proven
 * rejection may be retried, and anything unresolved must be reconciled first. */
const tonOnce=async(id:string,messages:Parameters<typeof t.send>[1])=>{
 const prior=done().get(id);if(prior)return prior;
 const attempts=ton.list().filter(r=>r.id===id||r.id.startsWith(`${id}#`));
 if(attempts.some(r=>r.stage!=='confirmed'&&r.stage!=='rejected'))throw new Error(`Send ${id} is unresolved; run reconcile:ton first`);
 const confirmed=attempts.find(r=>r.stage==='confirmed');
 const step=confirmed?{id:confirmed.id,reconciled:'wallet execution confirmed by reconcile:ton'}:await t.send(id,messages);
 evidence.steps.push(step);save();return step;
};
const m=await openMidnight(),t=openTon(),recipient={bytes:Buffer.from(addressFromKey(m.wallet.unshieldedKeystore.getPublicKey()),'hex')};
const standard=plan.adapter==='tep74-reference';
const walletCode=Cell.fromBase64(JSON.parse(readFileSync('build/ton/test-wallet.json','utf8')).codeBoc64);
const wait=async<T>(fn:()=>Promise<T>):Promise<T>=>{const end=Date.now()+180000;let error:unknown;while(Date.now()<end){try{return await fn();}catch(e){error=e;}await new Promise(r=>setTimeout(r,3000));}throw error;};
// Every Midnight call is journaled before broadcast. A finalized call missing from the
// evidence (a crash after finality) must be inspected, never repeated.
const applied=()=>m.journal.list().filter(r=>r.payload!=='DUST registration'&&r.stage==='confirmed').length;
evidence.midnightJournalBase??=applied();save();
const circuits=()=>evidence.steps.filter((x:any)=>x.circuit).length;
if(applied()-evidence.midnightJournalBase!==circuits())throw new Error('A finalized Midnight call is missing from the evidence; inspect the journal before resuming');
const record=async(circuit:Parameters<typeof m.call>[1],args:()=>unknown[])=>{
 const start=Date.now();const r=await m.call(d.address,circuit,args());
 const step={circuit,txId:r.public.txId,blockHeight:r.public.blockHeight,blockHash:r.public.blockHash,status:r.public.status,milliseconds:Date.now()-start};
 evidence.steps.push(step);save();await syncWallet(m.wallet.wallet,1000,900000);return step;
};
const once=async(key:string,fn:()=>Promise<any>)=>done().get(key)??fn();
/** Private values are persisted before first use, so a resumed run reuses them. */
const secretOnce=(name:string)=>{const p=statePath(name);if(!existsSync(p))writeFileSync(p,JSON.stringify({secret:randomBytes(32).toString('hex')}),{mode:0o600,flag:'wx'});return Buffer.from(readSecret<{secret:string}>(p).secret,'hex');};
try{
 if(!resume){const initial=await m.providers.publicDataProvider.queryContractState(d.address);if(!initial||ledger(initial.data).circulating.some(x=>x!==0n))throw new Error('fresh Midnight deployment required');}
 for(const asset of [0,1] as const){
  const a=plan.assets[asset],master=Address.parse(a.master),escrow=Address.parse(a.escrow),wc=standard?Cell.fromBase64(a.walletCodeBoc):walletCode,userWallet=standard?referenceWallet(t.wallet.address,master,wc):jettonWallet(t.wallet.address,master,wc);
  if(standard){await verifyAsset(t.client,a,escrow);await verifyAsset(t.client,a,t.wallet.address);}
  if(!process.argv.includes('--existing-balances')){
   if(standard&&!plan.testnetIssuance)throw new Error('Existing token masters require --existing-balances; no issuer mint authority assumed');
   await tonOnce(`demo-mint:${d.domain}:${asset}`,[internal({to:master,value:toNano('0.2'),body:standard?referenceMintBody(t.wallet.address,10000n,BigInt(asset)):beginCell().storeUint(0x4d494e54,32).storeAddress(t.wallet.address).storeUint(10000,64).endCell()})]);
  }
  if(!done().has(`demo-deposit:${d.domain}:${asset}`))await wait(async()=>{const h=await t.client.getLastBlock();const r=await t.client.runMethod(h.last.seqno,userWallet.address,'get_wallet_data');assert(r.reader.readBigNumber()>=10000n);});
  await tonOnce(`demo-deposit:${d.domain}:${asset}`,[internal({to:userWallet.address,value:toNano('0.2'),body:transferBody(BigInt(100+asset),10000n,escrow,t.wallet.address,Buffer.from(recipient.bytes))})]);
  const receipt=(await once(`receipt:${asset}`,async()=>{const step={deposit:await wait(async()=>observeTon(t.client,{...a,confirmationDepth:3},0n))};evidence.steps.push(step);save();return step;})).deposit;
  const digest=pureCircuits.claimDigest(Buffer.from(d.domain,'hex'),Buffer.from(d.address,'hex'),Buffer.from(receipt.id,'hex'),BigInt(asset),10000n,recipient);
  await once(`claim:${asset}`,()=>record('claim',()=>[Buffer.from(receipt.id,'hex'),BigInt(asset),10000n,recipient,0n,2n,signClaim(digest,BigInt(ops[0]!.midnight)),signClaim(digest,BigInt(ops[2]!.midnight))]));
 }
 const secret=secretOnce('testnet-lp-secret.json'),owner=persistentHash(new CompactTypeBytes(32),secret);
 await once('addLiquidity:0',()=>record('addLiquidity',()=>[owner,5000n,5000n,5000n]));
 await once('swap:0',()=>record('swap',()=>[0n,100n,quoteSwap(100n,5000n,5000n),recipient]));
 await once('removeLiquidity:0',()=>record('removeLiquidity',()=>[secret,5000n,0n,0n,recipient]));
 const nonce=secretOnce('testnet-redemption-nonce.json'),id=Buffer.from(pureCircuits.redemptionId(nonce));
 const retirement=await once('redeem:0',()=>record('redeem',()=>[nonce,0n,100n,t.wallet.address.hash]));
 const blockHash=retirement.blockHash??(await m.providers.publicDataProvider.watchForTxData(retirement.txId)).blockHash;
 const request={id:id.toString('hex'),asset:0 as const,amount:'100',recipient:t.wallet.address.toRawString(),transactionId:retirement.txId};
 const snapshot=await m.providers.publicDataProvider.queryContractState(d.address,{type:'blockHash',blockHash});if(!snapshot)throw new Error('missing retirement state');
 const digest=verifyRedemption(snapshot,d.pins,request,[plan.assets[0].escrow,plan.assets[1].escrow]);
 const body=releaseBody(id,100n,t.wallet.address,0,2,signRelease(digest,keyPairFromSeed(Buffer.from(ops[0]!.tonSeed,'hex')).secretKey),signRelease(digest,keyPairFromSeed(Buffer.from(ops[2]!.tonSeed,'hex')).secretKey));
 await tonOnce(`demo-release:${id.toString('hex')}`,[internal({to:Address.parse(plan.assets[0].escrow),value:toNano('0.2'),body})]);
 const master=Address.parse(plan.assets[0].master),escrow=Address.parse(plan.assets[0].escrow),wc=standard?Cell.fromBase64(plan.assets[0].walletCodeBoc):walletCode,walletFor=standard?referenceWallet:jettonWallet;
 evidence.delivery=await wait(()=>verifyJettonDelivery(t.client,walletFor(escrow,master,wc).address,walletFor(t.wallet.address,master,wc).address,0n,100n));
 const h=await t.client.getLastBlock(),locked=await t.client.runMethod(h.last.seqno-3,escrow,'locked');assert.equal(locked.reader.readBigNumber(),9900n);
 const final=ledger(snapshot.data);assert.deepEqual(final.reserve,[0n,0n]);assert.deepEqual(final.circulating,[9900n,10000n]);assert.equal(final.totalShares,0n);
 evidence.complete=true;evidence.final={circulating:final.circulating,reserve:final.reserve,shares:final.totalShares};save();console.log('Two-chain bridge testnet round trip verified. Evidence:',evidencePath);
}finally{ton.close();await m.close();}
