import {existsSync,mkdirSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {Address,Cell,internal,toNano} from '@ton/core';
import {addressFromKey} from '@midnight-ntwrk/ledger-v8';
import {network,readJson,readSecret,readState,stateDirectory,statePath} from '../src/environment.js';
import {toJson} from '../src/encoding.js';
import {openTon} from '../src/live-ton.js';
import {Journal} from '../src/journal.js';
import {transferBody} from '../src/ton.js';
import {depositId,type EscrowPins} from '../src/escrow.js';
import {referenceWallet,referenceMintBody,type JettonAsset} from '../src/jettons.js';
import {BridgeClient,type BridgeConfig} from '../src/sdk.js';
import {parseBridgeConfig} from '../src/attest.js';
import {openIndexer} from '../src/midnight-indexer.js';
import {verifyJettonDelivery} from '../src/ton-traces.js';
import {finalizedBlock} from '../src/ton-network.js';
import type {MidnightPins} from '../src/redemptions.js';
import {ledger} from '../build/midnight/contract/index.js';
import {evidenceSteps} from './lib/steps.js';
import {flag,stateSecret,waitFor} from './lib/util.js';

// Live check of the automated path: a TON deposit and a Midnight redemption moved only by
// `watch -- signer` (slots 0 and 2) and `watch -- relayer` subprocesses through a mailbox.
// Run after demo:testnet on a settled route. Resumable; --publish writes public evidence.
if(network()!=='preprod')throw new Error('Public testnets only');
const d=readState<{address:string;domain:string;pins:MidnightPins;network:string}>('midnight-deployment.json');
const plan=readState<{domain:string;testnetIssuance:boolean;assets:(JettonAsset&EscrowPins)[]}>('ton-plan.json');
if(d.domain!==plan.domain)throw new Error('deployment route mismatch');
const AMOUNT=500n,asset=0 as const,a=plan.assets[asset]!,escrow=Address.parse(a.escrow);
const dir=join(stateDirectory(),'relayer-demo'),mailbox=join(dir,'mailbox');mkdirSync(dir,{recursive:true,mode:0o700});
const evidencePath=statePath('relayer-evidence.json'),resume=flag('--resume');
if(existsSync(evidencePath)&&!resume)throw new Error('Prior relayer demonstration exists; continue it with --resume');
const evidence:any=existsSync(evidencePath)?readJson(evidencePath):{network:'TON-testnet/Midnight-preprod',midnight:d.address,escrow:a.escrow,amount:AMOUNT.toString(),steps:[]};
const save=()=>writeFileSync(evidencePath,toJson(evidence));
if(evidence.complete)throw new Error('Relayer demonstration already complete');

// Signer and relayer configs from the route's public deployment and the demo committee keys.
const ops=readSecret<{midnight:string;tonSeed:string}[]>(statePath('demo-operators.json'));
const tonCommittee=readState<string[]>('ton-public-committee.json'),midnightCommittee=readState<BridgeConfig['committee']>('midnight-public-committee.json');
const bridge:BridgeConfig={network:'preprod',domain:d.domain,midnightAddress:d.address,escrows:[plan.assets[0]!.escrow,plan.assets[1]!.escrow],committee:midnightCommittee};
const pins=plan.assets.map(x=>({escrow:x.escrow,codeHash:x.codeHash,configHash:x.configHash,master:x.master}));
const write=(name:string,value:unknown,mode=0o600)=>{const p=join(dir,name);writeFileSync(p,toJson(value),{mode});return p;};
const signerConfig=(slot:0|2)=>{
 const keyFile=write(`operator-${slot}.json`,{tonSeed:ops[slot]!.tonSeed,midnight:ops[slot]!.midnight});
 const policy={maxTransfer:'100000',maxPerDay:'1000000',stopFile:join(dir,`STOP-${slot}`),database:join(dir,`signing-${slot}.sqlite`)};
 const deposit=write(`deposit-${slot}.json`,{signer:slot,keyFile,policy,rpc:process.env.TON_RPC_URL??'https://testnet-v4.tonhubapi.com',source:{...pins[asset],asset,confirmationDepth:3},bridge});
 const redemption=write(`redemption-${slot}.json`,{signer:slot,keyFile,policy,network:'preprod',address:d.address,pins:d.pins,escrows:pins,committee:tonCommittee});
 return write(`signer-${slot}.json`,{mailbox,deposits:[deposit],redemption});
};
const signers=[signerConfig(0),signerConfig(2)];
const relayerConfig=write('relayer.json',{mailbox,bridge,ton:{network:'ton-testnet',domain:d.domain,escrows:bridge.escrows,committee:tonCommittee,walletKeyFile:statePath('ton-test-wallet.json')}});
/** One `watch --once` pass in a subprocess, exactly as an operator would run it. */
const watch=(...args:string[])=>{
 const r=spawnSync(process.execPath,['--import','tsx',resolve('scripts/watch.ts'),...args,'--once'],{encoding:'utf8',env:process.env,timeout:1800000});
 const events=r.stdout.trim().split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l);}catch{return {line:l};}});
 if(r.status!==0)throw new Error(`watch ${args[0]} failed: ${r.stderr.slice(-2000)}`);
 return events;
};
const signed=(kind:string,id:string)=>{try{return readdirSync(join(mailbox,kind,id)).filter(f=>/^[012]\.json$/.test(f)).length;}catch{return 0;}};

const t=openTon(),tonJournal=new Journal(statePath('ton-transactions.sqlite'));
const {done,once,tonOnce}=evidenceSteps(evidence,save,tonJournal,(id,messages)=>t.send(id,messages));
const indexer=openIndexer('preprod');
const claimed=async(id:string)=>{const s=await indexer.queryContractState(d.address);return !!s&&ledger(s.data).claimed.member(Buffer.from(id,'hex'));};
const walletOf=(owner:Address)=>referenceWallet(owner,Address.parse(a.master),Cell.fromBase64(a.walletCodeBoc)).address;
const finalized=async(name:string,args:Parameters<typeof t.client.runMethod>[3]=[])=>{const {block}=await finalizedBlock(t.client),r=await t.client.runMethod(block,escrow,name,args);if(r.exitCode!==0)throw new Error(`${name} unavailable`);return r.reader;};
try{
 // The Midnight wallet receives the claim and later redeems it; open it only briefly, since
 // the relayer subprocess needs the same wallet lock.
 if(!evidence.recipient){
  const {openMidnight}=await import('../src/live-midnight.js'),m=await openMidnight({waitForFunds:false});
  try{evidence.recipient=addressFromKey(m.wallet.unshieldedKeystore.getPublicKey());save();}finally{await m.close();}
 }
 if(!plan.testnetIssuance)throw new Error('This demonstration mints testnet tokens; the route must use testnet issuance');
 await tonOnce(`relayer-mint:${d.domain}`,[internal({to:Address.parse(a.master),value:toNano('0.2'),body:referenceMintBody(t.wallet.address,AMOUNT,7n)})]);
 // The deposit's sequence is the escrow's count before it is recorded.
 evidence.sequence??=(await finalized('depositCount')).readBigNumber().toString();save();
 const receipt=depositId(a.escrow,BigInt(evidence.sequence));evidence.receipt=receipt;save();
 if(!done().has(`relayer-deposit:${receipt}`))await waitFor(async()=>{const h=await t.client.getLastBlock(),r=await t.client.runMethod(h.last.seqno,walletOf(t.wallet.address),'get_wallet_data');assert(r.reader.readBigNumber()>=AMOUNT);});
 await tonOnce(`relayer-deposit:${receipt}`,[internal({to:walletOf(t.wallet.address),value:toNano('0.2'),body:transferBody(9001n,AMOUNT,escrow,t.wallet.address,Buffer.from(evidence.recipient,'hex'))})]);
 await once('claim',async()=>{
  const started=Date.now();
  await waitFor(async()=>{for(const s of signers)watch('signer',s);assert.equal(signed('claims',receipt),2);},{timeoutMs:900000,intervalMs:15000});
  const events=watch('relayer',relayerConfig);
  assert(await claimed(receipt),`claim not accepted: ${JSON.stringify(events)}`);
  return {receipt,relayer:events.filter(e=>e.event==='claim-submitted'),milliseconds:Date.now()-started};
 });
 // Redeem the claimed tokens back to the TON wallet with the SDK, then let the committee act.
 const nonce=stateSecret('relayer-redemption-nonce.json').toString('hex');
 const redeemed=await once('redeem',async()=>{
  const {openMidnight}=await import('../src/live-midnight.js'),m=await openMidnight();
  try{
   const client=new BridgeClient(parseBridgeConfig(bridge),{call:async(c,args)=>(await m.call(d.address,c,args)).public.txId});
   const r=await client.redeem(asset,AMOUNT,t.wallet.address.toRawString(),nonce);return {request:r.request};
  }finally{await m.close();}
 }) as unknown as {request:{id:string}};
 const request=redeemed.request;
 await once('release',async()=>{
  const started=Date.now();
  writeFileSync(join(dir,'request.json'),JSON.stringify(request));watch('request',mailbox,join(dir,'request.json'));
  await waitFor(async()=>{for(const s of signers)watch('signer',s);assert.equal(signed('releases',request.id),2);},{timeoutMs:900000,intervalMs:15000});
  // The escrow numbers outgoing transfers; read the query this release will use first.
  evidence.releaseQuery??=(await finalized('nextRelease')).readBigNumber().toString();save();
  const events=watch('relayer',relayerConfig);
  const delivery=await waitFor(()=>verifyJettonDelivery(t.client,walletOf(escrow),walletOf(t.wallet.address),BigInt(evidence.releaseQuery),AMOUNT),{timeoutMs:600000,intervalMs:10000});
  return {id:request.id,relayer:events.filter(e=>e.event==='release-submitted'),delivery,milliseconds:Date.now()-started};
 });
 // A further pass must find nothing left to do.
 const idle=[...watch('relayer',relayerConfig),...signers.flatMap(s=>watch('signer',s))].filter(e=>/submitted|signed/.test(e.event));
 assert.deepEqual(idle,[],'a settled transfer was signed or relayed again');
 evidence.complete=true;save();
 if(flag('--publish'))writeFileSync('docs/evidence/testnet-relayer.json',toJson(evidence)+'\n');
 console.log('Automated signer and relayer round trip verified. Evidence:',evidencePath);
}finally{tonJournal.close();}
