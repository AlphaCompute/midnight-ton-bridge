import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ecMulGenerator,createConstructorContext,createCircuitContext,sampleContractAddress,persistentHash,CompactTypeBytes} from '@midnight-ntwrk/compact-runtime';
import {Contract,ledger,pureCircuits} from '../build/midnight/contract/index.js';
import {verifyingKey,signClaim,verifyClaim,validPoint,JUBJUB_ORDER,witnesses,quoteSwap} from '../src/midnight.js';
import {network,stateDirectory,readSecret} from '../src/environment.js';
function setup(w=witnesses){const c=new Contract(w),keys=[11n,22n,33n],domain=Buffer.alloc(32,21),address=sampleContractAddress();const initial=c.initialState(createConstructorContext({},'00'.repeat(32)),domain,keys.map(verifyingKey),1000000n);return {c,keys,domain,address,ctx:createCircuitContext(address,'00'.repeat(32),initial.currentContractState,{})};}
test('canonical Schnorr scalars, nonidentity and subgroup membership fail closed',()=>{
 const s=setup(),id=Buffer.alloc(32,7),to={bytes:Buffer.alloc(32,4)},digest=pureCircuits.claimDigest(s.domain,Buffer.from(s.address,'hex'),id,0n,100n,to);
 const a=signClaim(digest,11n),b=signClaim(digest,33n),identity=ecMulGenerator(0n);
 const altered={...a,response:a.response+JUBJUB_ORDER};assert(!verifyClaim(digest,verifyingKey(11n),altered));
 assert.throws(()=>s.c.impureCircuits.claim(s.ctx,id,0n,100n,to,0n,2n,altered,b),/noncanonical/);
 assert.throws(()=>s.c.impureCircuits.claim(s.ctx,id,0n,100n,to,0n,2n,{...a,announcement:identity},b),/identity/);
 assert(!validPoint(identity));assert(!validPoint({x:1n,y:1n}));
 // The order-two Edwards point is on-curve but outside the prime subgroup.
 const torsion={x:0n,y:52435875175126190479447740508185965837690552500527637822603658699938581184512n};
 assert(!validPoint(torsion));
 for(const point of [identity,torsion])assert.throws(()=>s.c.initialState(createConstructorContext({},'00'.repeat(32)),s.domain,[point,verifyingKey(22n),verifyingKey(33n)],1000n));
 assert.throws(()=>s.c.impureCircuits.claim(s.ctx,id,0n,100n,to,0n,2n,{...a,announcement:torsion},b));
});
test('pool rejects donations and dishonest division witnesses; seeded swaps preserve product',()=>{
 const s=setup(),to={bytes:Buffer.alloc(32,4)},secret=Buffer.alloc(32,8),owner=persistentHash(new CompactTypeBytes(32),secret);
 s.ctx=s.c.impureCircuits.addLiquidity(s.ctx,owner,10000n,10000n,10000n).context;
 assert.throws(()=>s.c.impureCircuits.addLiquidity(s.ctx,owner,100n,101n,1n),/donation/);
 assert.throws(()=>s.c.impureCircuits.addLiquidity(s.ctx,owner,100n,99n,1n),/donation/);
 const bad=new Contract({...witnesses,quotient:({privateState},n,d)=>[privateState,n/d+1n]});
 assert.throws(()=>bad.impureCircuits.swap(s.ctx,0n,100n,1n,to),/quotient/);
 let seed=123456789;
 for(let i=0;i<40;i++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;const asset=BigInt(seed%2),amount=BigInt(2+seed%100);
  const before=ledger(s.ctx.currentQueryContext.state),out=quoteSwap(amount,before.reserve[Number(asset)]!,before.reserve[1-Number(asset)]!);
  s.ctx=s.c.impureCircuits.swap(s.ctx,asset,amount,out,to).context;
  const after=ledger(s.ctx.currentQueryContext.state);assert(after.reserve[0]!*after.reserve[1]!>=before.reserve[0]!*before.reserve[1]!);
 }
 s.ctx=s.c.impureCircuits.removeLiquidity(s.ctx,secret,10000n,0n,0n,to).context;
 assert.deepEqual(ledger(s.ctx.currentQueryContext.state).reserve,[0n,0n]);
});
test('network isolation, conflicting settings and secret permissions',()=>{
 const old={...process.env},dir=mkdtempSync(join(tmpdir(),'bridge-security-'));
 try{
  delete process.env.MIDNIGHT_NETWORK;delete process.env.BRIDGE_STATE_DIR;process.env.BRIDGE_NETWORK='preprod';assert.equal(network(),'preprod');assert(stateDirectory().endsWith('/.state/preprod'));
  process.env.MIDNIGHT_NETWORK='local';assert.throws(network,/conflicting/);delete process.env.MIDNIGHT_NETWORK;
  process.env.BRIDGE_NETWORK='wrong';assert.throws(network,/unknown/);
  const key=join(dir,'key.json');writeFileSync(key,'{"seed":"test"}',{mode:0o600});assert.equal(readSecret<{seed:string}>(key).seed,'test');chmodSync(key,0o644);assert.throws(()=>readSecret(key),/owner-only/);
 }finally{process.env=old;rmSync(dir,{recursive:true});}
});

test('signer quota is durable, idempotent, rejects equivocation and honors stop switch',async()=>{
 const {authorizeSignature}=await import('../src/signer-policy.js'),dir=mkdtempSync(join(tmpdir(),'bridge-policy-'));
 const policy={database:join(dir,'sign.sqlite'),stopFile:join(dir,'STOP'),maxTransfer:'100',maxPerDay:'150'};
 try{
  authorizeSignature(policy,'a','payload-a',100n);authorizeSignature(policy,'a','payload-a',100n);
  assert.throws(()=>authorizeSignature(policy,'a','conflict',1n),/conflicting/);
  assert.throws(()=>authorizeSignature(policy,'b','payload-b',51n),/daily/);
  authorizeSignature(policy,'b','payload-b',50n);
  assert.throws(()=>authorizeSignature(policy,'c','payload-c',101n),/transfer/);
  writeFileSync(policy.stopFile,'stop');assert.throws(()=>authorizeSignature(policy,'a','payload-a',100n),/paused/);
 }finally{rmSync(dir,{recursive:true});}
});

test('TON RPC identity rejects a mislabeled mainnet or unknown endpoint',async()=>{
 const {assertTonTestnet,TON_TESTNET_ZERO_STATE}=await import('../src/ton-network.js');
 assert.doesNotThrow(()=>assertTonTestnet({init:{rootHash:TON_TESTNET_ZERO_STATE}}));
 assert.throws(()=>assertTonTestnet({init:{rootHash:'wrong-chain'}}),/not the pinned/);
});
