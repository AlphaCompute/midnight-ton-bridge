import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Address} from '@ton/core';
import {transferBody,signTonDigest} from '../src/ton.js';
import {depositId} from '../src/escrow.js';
import {retirementRelease} from '../src/redemptions.js';
import {authorizeSignature} from '../src/signer-policy.js';
import {BridgeClient,type BridgeConfig} from '../src/sdk.js';
import {signClaim} from '../src/midnight.js';
import {Mailbox} from '../src/mailbox.js';
import {attestDeposit,type DepositSignerConfig,type ReleaseAttestation} from '../src/attest.js';
import {claimQuorum,releaseQuorum,type TonRelayConfig} from '../src/quorum.js';
import {jsonLog,relayerPass,signerPass,type Log} from '../src/watcher.js';
import {toJson} from '../src/encoding.js';
import {route,type Route} from './helpers/standard-route.js';
import {MIDNIGHT_SECRETS,deployMidnight,midnightCommittee,type Ctx,type Midnight} from './helpers/midnight.js';
import {TON_COMMITTEE,TON_KEYS} from './helpers/ton.js';
import {withTempDir} from './helpers/env.js';

const recipient=Buffer.alloc(32,9),silent:Log=()=>{};
/** A standard route, an in-memory Midnight deployment for it and one signer config per slot. */
async function setup(dir:string){
 const r=await route(1000n),m=deployMidnight({domain:r.domain});
 const escrows:[string,string]=[r.escrow.address.toRawString(),r.attacker.address.toRawString()];
 const config:BridgeConfig={network:'local',domain:r.domain.toString('hex'),midnightAddress:m.address,escrows,committee:midnightCommittee()};
 const circuits=m.circuits as unknown as Record<string,(c:Ctx,...a:unknown[])=>{context:Ctx}>;
 let calls=0;
 const bridge=new BridgeClient(config,{call:async(circuit,args)=>{calls++;m.context=circuits[circuit]!(m.context,...args).context;return `${circuit}-${calls}`;}});
 const signerConfig=(signer:0|1|2,overrides:Partial<DepositSignerConfig>={}):DepositSignerConfig=>{
  const home=join(dir,`op${signer}`);mkdirSync(home,{recursive:true});
  const keyFile=join(home,'secret.json');
  writeFileSync(keyFile,toJson({tonSeed:Buffer.alloc(32,signer+1).toString('hex'),midnight:MIDNIGHT_SECRETS[signer].toString()}),{mode:0o600});
  return {signer,keyFile,rpc:'unused',policy:{maxTransfer:'1000',maxPerDay:'5000',stopFile:join(home,'STOP'),database:join(home,'signing.sqlite')},
   source:{escrow:escrows[0],codeHash:r.ec.hash().toString('hex'),configHash:r.configHash,asset:0,master:r.master.address.toRawString(),confirmationDepth:3},
   bridge:JSON.parse(toJson(config)),...overrides};
 };
 const deposit=async(amount:bigint,query:bigint)=>r.wallet.send(r.user.getSender(),transferBody(query,amount,r.escrow.address,r.user.address,recipient));
 return {r,m,bridge,config,signerConfig,deposit,calls:()=>calls};
}
const count=(r:Route)=>async()=>(await r.client.runMethod(0,r.escrow.address,'depositCount')).reader.readBigNumber();
const claimed=(m:Midnight)=>async(id:string)=>m.state.claimed.member(Buffer.from(id,'hex'));

test('deposit attestation checks the escrow route, token and signer key against the chain',async()=>withTempDir(async dir=>{
 const {r,signerConfig,deposit,bridge}=await setup(dir);await deposit(400n,1n);
 const a=await attestDeposit(signerConfig(0),r.client,0n);
 assert.equal(a.receipt.amount,'400');assert.equal(a.receipt.recipient,recipient.toString('hex'));assert.equal(a.receipt.id,depositId(r.escrow.address.toRawString(),0n));
 // Identical retries are idempotent; another slot's key, route or token is refused.
 await attestDeposit(signerConfig(0),r.client,0n);
 const wrongKey=signerConfig(1);writeFileSync(wrongKey.keyFile,toJson({tonSeed:'00'.repeat(32),midnight:MIDNIGHT_SECRETS[2].toString()}),{mode:0o600});
 await assert.rejects(()=>attestDeposit(wrongKey,r.client,0n),/committee slot/);
 const c0=signerConfig(0);
 await assert.rejects(()=>attestDeposit({...c0,bridge:{...c0.bridge,domain:'ab'.repeat(32)}},r.client,0n),/does not belong to this route/);
 await assert.rejects(()=>attestDeposit({...c0,source:{...c0.source,master:r.attacker.address.toRawString()}},r.client,0n),/does not belong to this route and token/);
 await assert.rejects(()=>attestDeposit({...c0,source:{...c0.source,master:''}},r.client,0n),/source.master/);
 await assert.rejects(()=>attestDeposit(c0,r.client,1n),/not found/);
 writeFileSync(c0.policy.stopFile,'');await assert.rejects(()=>attestDeposit(c0,r.client,0n),/paused/);
 // The signature verifies under the committee and nobody else's.
 assert(claimQuorum(bridge,[a,{...a,attestation:{...a.attestation,signer:1}}])===null);
}));

test('signers and relayer move a deposit to a Midnight claim exactly once',async()=>withTempDir(async dir=>{
 const {r,m,bridge,signerConfig,deposit,calls}=await setup(dir),mailbox=new Mailbox(join(dir,'mailbox'));
 await deposit(500n,1n);await deposit(2000n,2n);// the second exceeds the cap and becomes a refund
 const sign=(signer:0|1|2)=>signerPass({mailbox,signer,log:silent,claimed:claimed(m),
  deposits:[{escrow:r.escrow.address.toRawString(),count:count(r),attest:seq=>attestDeposit(signerConfig(signer),r.client,seq)}]});
 const relay=(done=new Set<string>())=>relayerPass({mailbox,bridge,log:silent,done,claimed:claimed(m),submitClaim:(receipt,a)=>bridge.claim(receipt,a),
  releaseState:async()=>{throw new Error('no releases expected');},sendRelease:async()=>{throw new Error('no releases expected');}});
 assert.equal(await sign(0),1);
 // One signature is not a quorum.
 assert.equal(await relay(),0);assert.equal(calls(),0);
 // A forged signature filed under another slot is ignored, not relayed.
 const id=depositId(r.escrow.address.toRawString(),0n),own=JSON.parse(readFileSync(join(dir,'mailbox','claims',id,'0.json'),'utf8'));
 mailbox.post('claims',id,1,{...own,attestation:{...own.attestation,signer:1}});
 assert.equal(await relay(),0);
 assert.equal(await sign(2),1);
 assert.equal(await relay(),1);
 assert.equal(m.state.circulating[0],500n);assert(m.state.claimed.member(Buffer.from(id,'hex')));
 // Already claimed: no further submission and no new signature.
 assert.equal(await relay(),0);assert.equal(await sign(1),0);assert.equal(calls(),1);
 assert.equal(await r.escrow.getNumber('refundCount'),1n);
}));

test('relayer submits a release only for a quorum over the recorded retirement, once',async()=>withTempDir(async dir=>{
 const {r,m,bridge,config,signerConfig,deposit}=await setup(dir),mailbox=new Mailbox(join(dir,'mailbox'));
 await deposit(500n,1n);
 const id=depositId(r.escrow.address.toRawString(),0n),[a,b]=await Promise.all([attestDeposit(signerConfig(0),r.client,0n),attestDeposit(signerConfig(2),r.client,0n)]);
 await bridge.claim(a.receipt,[a.attestation,b.attestation]);assert(m.state.claimed.member(Buffer.from(id,'hex')));
 const {request}=await bridge.redeem(0,200n,r.user.address.toRawString(),'cd'.repeat(32));
 assert.equal(mailbox.submitRequest(request),true);assert.equal(mailbox.submitRequest(request),false);
 assert.throws(()=>mailbox.submitRequest({...request,amount:'201'}),/different request/);
 const ton:TonRelayConfig={network:'ton-testnet',domain:config.domain,escrows:config.escrows,committee:TON_COMMITTEE.map(k=>k.toString('hex')),walletKeyFile:'unused'};
 const releaseState=async(escrow:Address,rid:string)=>(await r.client.runMethod(0,escrow,'releaseState',[{type:'int',value:BigInt('0x'+rid)}])).reader.readNumber();
 // Each signer derives the release only from the retirement recorded in contract state.
 const sign=(signer:0|1|2)=>signerPass({mailbox,signer,log:silent,claimed:async()=>true,deposits:[],redemption:{
  released:async q=>await releaseState(Address.parse(config.escrows[q.asset]),q.id)!==0,
  attest:async q=>{const c=signerConfig(signer),digest=retirementRelease(m.state,config.domain,q,config.escrows);
   authorizeSignature(c.policy,`release:${m.address}:${q.id}`,digest.toString('hex'),BigInt(q.amount));
   return {request:q,blockHash:'local',blockHeight:0,signer,signature:signTonDigest(digest,TON_KEYS[signer]!.secretKey).toString('hex')} satisfies ReleaseAttestation;}}});
 let sent=0;
 const relay=()=>relayerPass({mailbox,bridge,ton,log:silent,claimed:claimed(m),submitClaim:async()=>{throw new Error('no claims expected');},releaseState,
  sendRelease:async(escrow,body)=>{sent++;return r.escrow.address.equals(escrow)&&r.escrow.send(r.attacker.getSender(),body);}});
 // A request for more than was retired is refused by every signer and never relayed.
 const inflated={...request,id:'ef'.repeat(32),amount:'999'};mailbox.submitRequest(inflated);
 assert.equal(await sign(0),1);assert.equal(await relay(),0);
 assert.equal(await sign(1),1);
 const before=await r.balance(r.wallet);
 assert.equal(await relay(),1);assert.equal(sent,1);
 assert.equal(await r.balance(r.wallet),before+200n);assert.equal(await r.escrow.getNumber('locked'),300n);
 // Released: no resend, and the remaining signer has nothing to sign.
 assert.equal(await relay(),0);assert.equal(await sign(2),0);assert.equal(sent,1);
 assert.deepEqual(readdirSync(join(dir,'mailbox','releases')),[request.id]);
 assert(releaseQuorum(ton,mailbox.entries('releases').get(request.id)!));
}));

test('mailbox refuses path-like ids, keeps the first attestation and skips malformed files',()=>withTempDir(dir=>{
 const mailbox=new Mailbox(dir),id='aa'.repeat(32);
 assert.throws(()=>mailbox.post('claims','../../etc',0,{}),/32-byte hex/);
 assert.throws(()=>mailbox.post('claims',id,3,{}),/signer/);
 assert.equal(mailbox.post('claims',id,0,{first:true}),true);assert.equal(mailbox.post('claims',id,0,{first:false}),false);
 writeFileSync(join(dir,'claims',id,'1.json'),'{partial');writeFileSync(join(dir,'claims',id,'evil.json'),'{}');
 assert.deepEqual(mailbox.entries('claims').get(id),[{first:true}]);
 writeFileSync(join(dir,'requests','bb'.repeat(32)+'.json'),JSON.stringify({id:'cc'.repeat(32),asset:0,amount:'1',recipient:'x',transactionId:'t'}));
 assert.deepEqual(mailbox.requests(),[]);// filed under another id
 assert.throws(()=>mailbox.submitRequest({id:'cc'.repeat(32),asset:0,amount:'-1',recipient:'x',transactionId:'t'}),/positive decimal/);
}));

test('json log suppresses identical repeats per id',()=>{
 const lines:string[]=[],log=jsonLog('t',l=>lines.push(l));
 log('failed',{id:'a',error:'x'});log('failed',{id:'a',error:'x'});log('failed',{id:'a',error:'y'});log('failed',{id:'b',error:'x'});
 assert.equal(lines.length,3);assert.equal(JSON.parse(lines[0]!).role,'t');
});

test('claim quorum ignores disagreeing receipts and picks two distinct valid signers',async()=>withTempDir(async dir=>{
 const {r,bridge,signerConfig,deposit}=await setup(dir);await deposit(300n,1n);
 const [a,b,c]=await Promise.all([0,1,2].map(s=>attestDeposit(signerConfig(s as 0|1|2),r.client,0n)));
 const tampered={...b!,receipt:{...b!.receipt,amount:'301'}};
 assert.equal(claimQuorum(bridge,[a,tampered]),null);
 const q=claimQuorum(bridge,[c,tampered,a,'junk',null])!;assert.deepEqual(q.attestations.map(x=>x.signer),[0,2]);
 // A signature over the right digest from a non-member key is not a committee signature.
 const digest=bridge.claimDigest(a!.receipt),stranger={...a!,attestation:{signer:1,signature:signClaim(digest,99n)}};
 assert.equal(claimQuorum(bridge,[a,stranger]),null);
}));
