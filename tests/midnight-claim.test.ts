import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ecMulGenerator,createConstructorContext} from '@midnight-ntwrk/compact-runtime';
import {verifyingKey,signClaim,verifyClaim,validPoint,JUBJUB_ORDER} from '../src/midnight.js';
import {MIDNIGHT_SECRETS,deployMidnight,claimDigest,claimSignatures} from './helpers/midnight.js';

const recipient={bytes:Buffer.alloc(32,4)};

test('compiled Midnight claim: valid quorum, invalid signatures, recipient binding and replay',()=>{
 const m=deployMidnight(),receipt=Buffer.alloc(32,1),digest=claimDigest(m,receipt,0n,1000n,recipient);
 const sa=signClaim(digest,MIDNIGHT_SECRETS[0]),sb=signClaim(digest,MIDNIGHT_SECRETS[2]);
 assert(verifyClaim(digest,verifyingKey(MIDNIGHT_SECRETS[0]),sa));assert(!verifyClaim(digest,verifyingKey(MIDNIGHT_SECRETS[1]),sa));
 assert.throws(()=>m.circuits.claim(m.context,receipt,0n,1000n,recipient,0n,1n,sa,sb),/invalid signature B/);
 assert.throws(()=>m.circuits.claim(m.context,receipt,0n,1001n,recipient,0n,2n,sa,sb),/invalid signature A/);
 m.context=m.circuits.claim(m.context,receipt,0n,1000n,recipient,0n,2n,sa,sb).context;
 assert.equal(m.state.circulating[0],1000n);
 assert.throws(()=>m.circuits.claim(m.context,receipt,0n,1000n,recipient,0n,2n,sa,sb),/replayed receipt/);
});

test('compiled Midnight claim binds contract, domain, asset and recipient; cap and quorum fail closed',()=>{
 const m=deployMidnight(),r=Buffer.alloc(32,51),claim=(asset:bigint,amount:bigint,to:{bytes:Uint8Array},a:bigint,b:bigint,[sa,sb]:ReturnType<typeof claimSignatures>)=>m.circuits.claim(m.context,r,asset,amount,to,a,b,sa,sb);
 for(const [domain,address] of [[Buffer.alloc(32,8),m.addressBytes],[m.domain,Buffer.alloc(32,9)]] as const)assert.throws(()=>claim(0n,100n,recipient,0n,2n,claimSignatures(m,r,0n,100n,recipient,domain,address)),/invalid signature/);
 const sigs=claimSignatures(m,r,0n,100n,recipient);
 assert.throws(()=>claim(1n,100n,recipient,0n,2n,sigs),/invalid signature/);
 assert.throws(()=>claim(0n,100n,{bytes:Buffer.alloc(32,99)},0n,2n,sigs),/invalid signature/);
 assert.throws(()=>claim(0n,100n,recipient,0n,0n,[sigs[0],sigs[0]]),/invalid quorum/);
 assert.throws(()=>claim(0n,1000001n,recipient,0n,2n,claimSignatures(m,r,0n,1000001n,recipient)),/supply cap/);
});

test('canonical Schnorr scalars, nonidentity and subgroup membership fail closed',()=>{
 const m=deployMidnight({domain:Buffer.alloc(32,21)}),id=Buffer.alloc(32,7),digest=claimDigest(m,id,0n,100n,recipient);
 const a=signClaim(digest,MIDNIGHT_SECRETS[0]),b=signClaim(digest,MIDNIGHT_SECRETS[2]),identity=ecMulGenerator(0n);
 const altered={...a,response:a.response+JUBJUB_ORDER};assert(!verifyClaim(digest,verifyingKey(MIDNIGHT_SECRETS[0]),altered));
 assert.throws(()=>m.circuits.claim(m.context,id,0n,100n,recipient,0n,2n,altered,b),/noncanonical/);
 assert.throws(()=>m.circuits.claim(m.context,id,0n,100n,recipient,0n,2n,{...a,announcement:identity},b),/identity/);
 assert(!validPoint(identity));assert(!validPoint({x:1n,y:1n}));
 // The order-two Edwards point is on-curve but outside the prime subgroup.
 const torsion={x:0n,y:52435875175126190479447740508185965837690552500527637822603658699938581184512n};
 assert(!validPoint(torsion));
 const deploy=(p:typeof identity)=>m.contract.initialState(createConstructorContext({},'00'.repeat(32)),m.domain,[p,verifyingKey(22n),verifyingKey(33n)],1000n);
 assert.throws(()=>deploy(identity),/identity committee key/);
 // The runtime traps (wasm `unreachable`) on the subgroup check rather than returning a named assertion.
 assert.throws(()=>deploy(torsion),/unreachable/);
 assert.throws(()=>m.circuits.claim(m.context,id,0n,100n,recipient,0n,2n,{...a,announcement:torsion},b),/unreachable/);
 assert.equal(m.state.circulating[0],0n);
});
