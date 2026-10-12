import {referenceWallet,referenceMintBody,verifyAsset,type JettonAsset} from '../src/jettons.js';
import {writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {Address,Cell,internal,toNano} from '@ton/core';
import {keyPairFromSeed} from '@ton/crypto';
import {addressFromKey} from '@midnight-ntwrk/ledger-v8';
import {syncWallet} from '@midnight-ntwrk/testkit-js';
import {network,readJson,statePath,readSecret,readState} from '../src/environment.js';
import {toJson} from '../src/encoding.js';
import {openMidnight} from '../src/live-midnight.js';
import {openTon} from '../src/live-ton.js';
import {Journal} from '../src/journal.js';
import {transferBody,releaseBody,signTonDigest} from '../src/ton.js';
import {observeTonDeposit,type EscrowPins} from '../src/escrow.js';
import {signClaim,type CircuitName} from '../src/midnight.js';
import {verifyRedemption,type MidnightPins} from '../src/redemptions.js';
import {verifyJettonDelivery} from '../src/ton-traces.js';
import {TON_FINALITY_DEPTH} from '../src/ton-network.js';
import {ledger,pureCircuits} from '../build/midnight/contract/index.js';
import {assertRoundTripLedger,poolAndRedeem} from './lib/round-trip.js';
import {flag,stateSecret,waitFor} from './lib/util.js';
if(network()!=='preprod')throw new Error('Public testnets only');
const d=readState<{address:string;domain:string;pins:MidnightPins;network:string}>('midnight-deployment.json');
const plan=readState<{network:string;adapter:string;domain:string;testnetIssuance:boolean;assets:(JettonAsset&EscrowPins)[]}>('ton-plan.json');
if(d.network!=='preprod'||plan.network!=='ton-testnet'||plan.adapter!=='tep74-reference'||d.domain!==plan.domain)throw new Error('deployment route mismatch');
const evidencePath=statePath('testnet-evidence.json'),resume=flag('--resume');
if(existsSync(evidencePath)&&!resume)throw new Error('Prior testnet attempt exists. Reconcile its journals (reconcile:ton, reconcile:midnight), then continue it with --resume.');
if(!existsSync(evidencePath)&&resume)throw new Error('No prior attempt to resume');
const ops=readSecret<{midnight:string;tonSeed:string}[]>(statePath('demo-operators.json'));
const evidence:any=resume?readJson(evidencePath):{network:'TON-testnet/Midnight-preprod',custody:'single developer host; synthetic assets only',midnight:d.address,ton:plan.assets,steps:[]};
if(evidence.complete)throw new Error('Demonstration already complete');
const save=()=>writeFileSync(evidencePath,toJson(evidence));
// A step is done once its evidence is saved. On --resume, finished steps are skipped and
// their recorded results reused; nothing that already executed is sent again.
const keyOf=(step:any,seen:Map<string,number>)=>{
 if(step.circuit){const n=seen.get(step.circuit)??0;seen.set(step.circuit,n+1);return `${step.circuit}:${n}`;}
 if(step.deposit)return `receipt:${step.deposit.asset}`;
 return String(step.id).replace(/#\d+$/,'');
};
const done=()=>{const seen=new Map<string,number>(),out=new Map<string,any>();for(const step of evidence.steps)out.set(keyOf(step,seen),step);return out;};
const once=async(key:string,fn:()=>Promise<any>)=>done().get(key)??fn();
const m=await openMidnight(),t=openTon(),tonJournal=new Journal(statePath('ton-transactions.sqlite'));
const recipient={bytes:Buffer.from(addressFromKey(m.wallet.unshieldedKeystore.getPublicKey()),'hex')};
const walletOf=(owner:Address,a:JettonAsset)=>referenceWallet(owner,Address.parse(a.master),Cell.fromBase64(a.walletCodeBoc)).address;
/** Sends once per logical ID. A confirmed earlier attempt counts as done; only a proven
 * rejection may be retried, and anything unresolved must be reconciled first. */
const tonOnce=async(id:string,messages:Parameters<typeof t.send>[1])=>{
 const prior=done().get(id);if(prior)return prior;
 const attempts=tonJournal.list().filter(r=>r.id===id||r.id.startsWith(`${id}#`));
 if(attempts.some(r=>r.stage!=='confirmed'&&r.stage!=='rejected'))throw new Error(`Send ${id} is unresolved; run reconcile:ton first`);
 const confirmed=attempts.find(r=>r.stage==='confirmed');
 const step=confirmed?{id:confirmed.id,reconciled:'wallet execution confirmed by reconcile:ton'}:await t.send(id,messages);
 evidence.steps.push(step);save();return step;
};
// Every Midnight call is journaled before broadcast. A finalized call missing from the
// evidence (a crash after finality) must be inspected, never repeated.
const applied=()=>m.journal.list().filter(r=>r.payload!=='DUST registration'&&r.stage==='confirmed').length;
evidence.midnightJournalBase??=applied();save();
if(applied()-evidence.midnightJournalBase!==evidence.steps.filter((x:any)=>x.circuit).length)throw new Error('A finalized Midnight call is missing from the evidence; inspect the journal before resuming');
const calls=new Map<string,number>();
/** The nth call of a circuit in this run; skipped when already in the evidence. */
const record=async(circuit:CircuitName,args:unknown[])=>{
 const n=calls.get(circuit)??0;calls.set(circuit,n+1);
 return once(`${circuit}:${n}`,async()=>{
  const start=Date.now(),r=await m.call(d.address,circuit,args);
  const step={circuit,txId:r.public.txId,blockHeight:r.public.blockHeight,blockHash:r.public.blockHash,status:r.public.status,milliseconds:Date.now()-start};
  evidence.steps.push(step);save();await syncWallet(m.wallet.wallet,1000,900000);return step;
 });
};
try{
 if(!resume){const initial=await m.providers.publicDataProvider.queryContractState(d.address);if(!initial||ledger(initial.data).circulating.some(x=>x!==0n))throw new Error('fresh Midnight deployment required');}
 for(const asset of [0,1] as const){
  const a=plan.assets[asset]!,master=Address.parse(a.master),escrow=Address.parse(a.escrow),userWallet=walletOf(t.wallet.address,a);
  await verifyAsset(t.client,a,escrow);await verifyAsset(t.client,a,t.wallet.address);
  if(!flag('--existing-balances')){
   if(!plan.testnetIssuance)throw new Error('Existing token masters require --existing-balances; no issuer mint authority assumed');
   await tonOnce(`demo-mint:${d.domain}:${asset}`,[internal({to:master,value:toNano('0.2'),body:referenceMintBody(t.wallet.address,10000n,BigInt(asset))})]);
  }
  if(!done().has(`demo-deposit:${d.domain}:${asset}`))await waitFor(async()=>{const h=await t.client.getLastBlock();const r=await t.client.runMethod(h.last.seqno,userWallet,'get_wallet_data');assert(r.reader.readBigNumber()>=10000n);});
  await tonOnce(`demo-deposit:${d.domain}:${asset}`,[internal({to:userWallet,value:toNano('0.2'),body:transferBody(BigInt(100+asset),10000n,escrow,t.wallet.address,Buffer.from(recipient.bytes))})]);
  const receipt=(await once(`receipt:${asset}`,async()=>{const step={deposit:await waitFor(()=>observeTonDeposit(t.client,{...a,confirmationDepth:TON_FINALITY_DEPTH},0n))};evidence.steps.push(step);save();return step;})).deposit;
  const digest=pureCircuits.claimDigest(Buffer.from(d.domain,'hex'),Buffer.from(d.address,'hex'),Buffer.from(receipt.id,'hex'),BigInt(asset),10000n,recipient);
  await record('claim',[Buffer.from(receipt.id,'hex'),BigInt(asset),10000n,recipient,0n,2n,signClaim(digest,BigInt(ops[0]!.midnight)),signClaim(digest,BigInt(ops[2]!.midnight))]);
 }
 const {id,retirement}=await poolAndRedeem(record,recipient,t.wallet.address.hash,{lp:stateSecret('testnet-lp-secret.json'),nonce:stateSecret('testnet-redemption-nonce.json')});
 const blockHash=retirement.blockHash??(await m.providers.publicDataProvider.watchForTxData(retirement.txId)).blockHash;
 const request={id:id.toString('hex'),asset:0 as const,amount:'100',recipient:t.wallet.address.toRawString(),transactionId:retirement.txId};
 const snapshot=await m.providers.publicDataProvider.queryContractState(d.address,{type:'blockHash',blockHash});if(!snapshot)throw new Error('missing retirement state');
 const digest=verifyRedemption(snapshot,d.pins,request,[plan.assets[0]!.escrow,plan.assets[1]!.escrow]);
 const sign=(i:number)=>signTonDigest(digest,keyPairFromSeed(Buffer.from(ops[i]!.tonSeed,'hex')).secretKey);
 const a0=plan.assets[0]!,escrow=Address.parse(a0.escrow);
 await tonOnce(`demo-release:${id.toString('hex')}`,[internal({to:escrow,value:toNano('0.2'),body:releaseBody(id,100n,t.wallet.address,0,2,sign(0),sign(2))})]);
 evidence.delivery=await waitFor(()=>verifyJettonDelivery(t.client,walletOf(escrow,a0),walletOf(t.wallet.address,a0),0n,100n));
 const h=await t.client.getLastBlock(),locked=await t.client.runMethod(h.last.seqno-TON_FINALITY_DEPTH,escrow,'locked');assert.equal(locked.reader.readBigNumber(),9900n);
 const final=ledger(snapshot.data);assertRoundTripLedger(final);
 evidence.complete=true;evidence.final={circulating:final.circulating,reserve:final.reserve,shares:final.totalShares};save();console.log('Two-chain bridge testnet round trip verified. Evidence:',evidencePath);
}finally{tonJournal.close();await m.close();}
