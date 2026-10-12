import {test} from 'node:test';
import assert from 'node:assert/strict';
import {persistentHash,CompactTypeBytes} from '@midnight-ntwrk/compact-runtime';
import {quoteSwap} from '../src/midnight.js';
import {deployMidnight,claimQuorum,contractWith} from './helpers/midnight.js';

const recipient={bytes:Buffer.alloc(32,4)};
const lpOwner=(secret:Buffer)=>persistentHash(new CompactTypeBytes(32),secret);

test('pool invariant, swap slippage and LP authentication',()=>{
 const m=deployMidnight();
 for(const asset of [0n,1n])claimQuorum(m,Buffer.alloc(32,Number(asset)+10),asset,10000n,recipient);
 const secret=Buffer.alloc(32,99);
 m.context=m.circuits.addLiquidity(m.context,lpOwner(secret),5000n,5000n,5000n).context;
 assert.equal(m.state.totalShares,5000n);
 const k=m.state.reserve[0]!*m.state.reserve[1]!,out=quoteSwap(100n,5000n,5000n);
 assert.throws(()=>m.circuits.swap(m.context,0n,100n,out+1n,recipient),/swap slippage/);
 m.context=m.circuits.swap(m.context,0n,100n,out,recipient).context;
 assert(m.state.reserve[0]!*m.state.reserve[1]!>=k);
 assert.throws(()=>m.circuits.removeLiquidity(m.context,Buffer.alloc(32,1),100n,0n,0n,recipient),/unknown LP/);
 m.context=m.circuits.removeLiquidity(m.context,secret,5000n,0n,0n,recipient).context;
 assert.deepEqual(m.state.reserve,[0n,0n]);assert.equal(m.state.totalShares,0n);
});

test('pool rejects donations and dishonest division witnesses; seeded swaps preserve product',()=>{
 const m=deployMidnight({domain:Buffer.alloc(32,21)}),secret=Buffer.alloc(32,8),owner=lpOwner(secret);
 m.context=m.circuits.addLiquidity(m.context,owner,10000n,10000n,10000n).context;
 assert.throws(()=>m.circuits.addLiquidity(m.context,owner,100n,101n,1n),/donation/);
 assert.throws(()=>m.circuits.addLiquidity(m.context,owner,100n,99n,1n),/donation/);
 const bad=contractWith({quotient:({privateState},n,d)=>[privateState,n/d+1n]});
 assert.throws(()=>bad.impureCircuits.swap(m.context,0n,100n,1n,recipient),/quotient/);
 let seed=123456789;
 for(let i=0;i<40;i++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;const asset=BigInt(seed%2),amount=BigInt(2+seed%100);
  const before=m.state,out=quoteSwap(amount,before.reserve[Number(asset)]!,before.reserve[1-Number(asset)]!);
  m.context=m.circuits.swap(m.context,asset,amount,out,recipient).context;
  const after=m.state;assert(after.reserve[0]!*after.reserve[1]!>=before.reserve[0]!*before.reserve[1]!);
 }
 m.context=m.circuits.removeLiquidity(m.context,secret,10000n,0n,0n,recipient).context;
 assert.deepEqual(m.state.reserve,[0n,0n]);
});
