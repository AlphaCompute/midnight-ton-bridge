import {redemptionCommitment} from '../src/redemptions.js';
import {Address} from '@ton/core';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConstructorContext,createCircuitContext,sampleContractAddress,persistentHash,CompactTypeBytes} from '@midnight-ntwrk/compact-runtime';
import {Contract,ledger,pureCircuits} from '../build/midnight/contract/index.js';
import {verifyingKey,signClaim,verifyClaim,witnesses,quoteSwap} from '../src/midnight.js';

function setup() {
 const contract=new Contract(witnesses),domain=Buffer.alloc(32,22),keys=[11n,22n,33n] as const;
 const initial=contract.initialState(createConstructorContext({},'00'.repeat(32)),domain,keys.map(verifyingKey),1000000n);
 const address=sampleContractAddress();
 let context=createCircuitContext(address,'00'.repeat(32),initial.currentContractState,{});
 return {contract,domain,keys,address,get context(){return context;},set context(c){context=c;},get state(){return ledger(context.currentQueryContext.state);}};
}
test('compiled Midnight circuit: valid quorum, invalid signatures, recipient binding and replay',()=>{
 const s=setup(),receipt=Buffer.alloc(32,1),recipient={bytes:Buffer.alloc(32,4)};
 const digest=pureCircuits.claimDigest(s.domain,Buffer.from(s.address,'hex'),receipt,0n,1000n,recipient);
 const sa=signClaim(digest,s.keys[0]),sb=signClaim(digest,s.keys[2]);
 assert(verifyClaim(digest,verifyingKey(s.keys[0]),sa));
 assert.throws(()=>s.contract.impureCircuits.claim(s.context,receipt,0n,1000n,recipient,0n,1n,sa,sb),/invalid signature B/);
 assert.throws(()=>s.contract.impureCircuits.claim(s.context,receipt,0n,1001n,recipient,0n,2n,sa,sb),/invalid signature A/);
 s.context=s.contract.impureCircuits.claim(s.context,receipt,0n,1000n,recipient,0n,2n,sa,sb).context;
 assert.equal(s.state.circulating[0],1000n);
 assert.throws(()=>s.contract.impureCircuits.claim(s.context,receipt,0n,1000n,recipient,0n,2n,sa,sb),/replayed receipt/);
});
test('compiled Midnight circuit: pool invariant, slippage, LP authentication and retirement',()=>{
 const s=setup(),recipient={bytes:Buffer.alloc(32,4)};
 for(const asset of [0n,1n]){
  const receipt=Buffer.alloc(32,Number(asset)+10),digest=pureCircuits.claimDigest(s.domain,Buffer.from(s.address,'hex'),receipt,asset,10000n,recipient);
  s.context=s.contract.impureCircuits.claim(s.context,receipt,asset,10000n,recipient,0n,2n,signClaim(digest,s.keys[0]),signClaim(digest,s.keys[2])).context;
 }
 const secret=Buffer.alloc(32,99),owner=persistentHash(new CompactTypeBytes(32),secret);
 s.context=s.contract.impureCircuits.addLiquidity(s.context,owner,5000n,5000n,5000n).context;
 assert.equal(s.state.totalShares,5000n);
 const k=s.state.reserve[0]!*s.state.reserve[1]!,out=quoteSwap(100n,5000n,5000n);
 assert.throws(()=>s.contract.impureCircuits.swap(s.context,0n,100n,out+1n,recipient),/swap slippage/);
 s.context=s.contract.impureCircuits.swap(s.context,0n,100n,out,recipient).context;
 assert(s.state.reserve[0]!*s.state.reserve[1]!>=k);
 assert.throws(()=>s.contract.impureCircuits.removeLiquidity(s.context,Buffer.alloc(32,1),100n,0n,0n,recipient),/unknown LP/);
 s.context=s.contract.impureCircuits.removeLiquidity(s.context,secret,5000n,0n,0n,recipient).context;
 assert.deepEqual(s.state.reserve,[0n,0n]);
 const nonce=Buffer.alloc(32,88),id=Buffer.from(pureCircuits.redemptionId(nonce));
 s.context=s.contract.impureCircuits.redeem(s.context,nonce,0n,100n,Buffer.alloc(32,12)).context;
 assert.equal(s.state.circulating[0],9900n);
 assert.deepEqual(s.state.retired.lookup(id),redemptionCommitment(0,100n,new Address(0,Buffer.alloc(32,12))));
 assert.throws(()=>s.contract.impureCircuits.redeem(s.context,nonce,0n,100n,Buffer.alloc(32,12)),/replayed redemption/);
 // Only the hash is public: retiring with the observed ID as a nonce yields another ID,
 // so a front-runner cannot occupy a pending redemption's ID.
 assert(!Buffer.from(pureCircuits.redemptionId(id)).equals(id));assert(!s.state.retired.member(nonce));
});

test('claim binds contract, domain, asset and recipient; cap and quorum fail closed',()=>{
 const s=setup(),r=Buffer.alloc(32,51),recipient={bytes:Buffer.alloc(32,4)};
 const sign=(domain:Uint8Array,address:Uint8Array,asset=0n,amount=100n,to=recipient)=>{const d=pureCircuits.claimDigest(domain,address,r,asset,amount,to);return [signClaim(d,s.keys[0]),signClaim(d,s.keys[2])] as const;};
 for(const [domain,address] of [[Buffer.alloc(32,8),Buffer.from(s.address,'hex')],[s.domain,Buffer.alloc(32,9)]] as const){const [a,b]=sign(domain,address);assert.throws(()=>s.contract.impureCircuits.claim(s.context,r,0n,100n,recipient,0n,2n,a,b),/invalid signature/);}
 const [a,b]=sign(s.domain,Buffer.from(s.address,'hex'));
 assert.throws(()=>s.contract.impureCircuits.claim(s.context,r,1n,100n,recipient,0n,2n,a,b),/invalid signature/);
 assert.throws(()=>s.contract.impureCircuits.claim(s.context,r,0n,100n,{bytes:Buffer.alloc(32,99)},0n,2n,a,b),/invalid signature/);
 assert.throws(()=>s.contract.impureCircuits.claim(s.context,r,0n,100n,recipient,0n,0n,a,a),/invalid quorum/);
 const [largeA,largeB]=sign(s.domain,Buffer.from(s.address,'hex'),0n,1000001n);
 assert.throws(()=>s.contract.impureCircuits.claim(s.context,r,0n,1000001n,recipient,0n,2n,largeA,largeB),/supply cap/);
});
