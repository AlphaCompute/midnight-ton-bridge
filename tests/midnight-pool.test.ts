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
 assert.throws(()=>m.circuits.addLiquidity(m.context,lpOwner(secret),1000n,1000n,0n),/minimum liquidity/);
 assert.throws(()=>m.circuits.addLiquidity(m.context,lpOwner(secret),5000n,5000n,4001n),/share slippage/);
 m.context=m.circuits.addLiquidity(m.context,lpOwner(secret),5000n,5000n,4000n).context;
 // 1,000 bootstrap shares are locked and owned by no one.
 assert.equal(m.state.totalShares,5000n);assert.equal(m.state.shares.lookup(lpOwner(secret)),4000n);
 const k=m.state.reserve[0]!*m.state.reserve[1]!,out=quoteSwap(100n,5000n,5000n);
 assert.throws(()=>m.circuits.swap(m.context,0n,100n,out+1n,recipient),/swap slippage/);
 m.context=m.circuits.swap(m.context,0n,100n,out,recipient).context;
 assert(m.state.reserve[0]!*m.state.reserve[1]!>=k);
 assert.throws(()=>m.circuits.removeLiquidity(m.context,Buffer.alloc(32,1),100n,0n,0n,recipient),/unknown LP/);
 assert.throws(()=>m.circuits.removeLiquidity(m.context,secret,4001n,0n,0n,recipient),/insufficient shares/);
 m.context=m.circuits.removeLiquidity(m.context,secret,4000n,0n,0n,recipient).context;
 assert.deepEqual(m.state.reserve,[1020n,981n]);assert.equal(m.state.totalShares,1000n);
});

test('pool rejects donations and dishonest division witnesses; seeded swaps preserve product',()=>{
 const m=deployMidnight({domain:Buffer.alloc(32,21)}),secret=Buffer.alloc(32,8),owner=lpOwner(secret);
 m.context=m.circuits.addLiquidity(m.context,owner,10000n,10000n,9000n).context;
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
 m.context=m.circuits.removeLiquidity(m.context,secret,9000n,0n,0n,recipient).context;
 // Only the locked bootstrap liquidity remains.
 assert.equal(m.state.totalShares,1000n);assert(m.state.reserve[0]!>0n&&m.state.reserve[1]!>0n);
});

test('the first liquidity provider cannot skim later deposits through share rounding',()=>{
 // Attack from review: tiny bootstrap, inflate reserve0 by swapping in, then let a victim
 // deposit with a floored quote. With 1,000 locked shares the attacker cannot profit.
 const m=deployMidnight({domain:Buffer.alloc(32,23)}),attacker=Buffer.alloc(32,1),victim=Buffer.alloc(32,2);
 for(const asset of [0n,1n])claimQuorum(m,Buffer.alloc(32,Number(asset)+30),asset,1_000_000n,recipient);
 m.context=m.circuits.addLiquidity(m.context,lpOwner(attacker),1001n,3n,1n).context;
 const inflate=100_000n;m.context=m.circuits.swap(m.context,0n,inflate,1n,recipient).context;
 const [r0,r1]=[m.state.reserve[0]!,m.state.reserve[1]!],x=2n*inflate,y=(x*r1+r0-1n)/r0,quote=x*m.state.totalShares/r0;
 m.context=m.circuits.addLiquidity(m.context,lpOwner(victim),x,y,quote).context;
 const attackerShares=m.state.shares.lookup(lpOwner(attacker)),before=[m.state.reserve[0]!,m.state.reserve[1]!] as const,total=m.state.totalShares;
 const attackerOut0=before[0]*attackerShares/total;
 // The attacker's withdrawable asset 0 is less than what they put in (1,001 + the swap input).
 assert(attackerOut0<1001n+inflate,`attacker would withdraw ${attackerOut0}`);
});


test('a low division witness is rejected by the quotient upper bound',()=>{
 const m=deployMidnight({domain:Buffer.alloc(32,24)});
 for(const asset of [0n,1n])claimQuorum(m,Buffer.alloc(32,Number(asset)+40),asset,10000n,recipient);
 m.context=m.circuits.addLiquidity(m.context,lpOwner(Buffer.alloc(32,1)),2000n,2000n,1n).context;
 // Honest requiredY for x=100 is 100; a floored-by-one witness would accept y=99 and mint extra swap output.
 const low=contractWith({quotient:({privateState},n,d)=>[privateState,n/d>0n?n/d-1n:0n]});
 assert.throws(()=>low.impureCircuits.addLiquidity(m.context,lpOwner(Buffer.alloc(32,2)),100n,99n,1n),/invalid quotient upper/);
 assert.throws(()=>low.impureCircuits.swap(m.context,0n,100n,1n,recipient),/invalid quotient upper/);
 assert.throws(()=>low.impureCircuits.removeLiquidity(m.context,Buffer.alloc(32,1),100n,0n,0n,recipient),/invalid quotient upper/);
});

test('redeem, liquidity and swap bounds fail with their named assertions',()=>{
 const m=deployMidnight({domain:Buffer.alloc(32,25)}),s1=Buffer.alloc(32,1),s2=Buffer.alloc(32,2),to=Buffer.alloc(32,3);
 claimQuorum(m,Buffer.alloc(32,50),0n,100n,recipient);
 assert.throws(()=>m.circuits.redeem(m.context,Buffer.alloc(32,9),0n,101n,to),/insufficient circulation/);
 assert.throws(()=>m.circuits.redeem(m.context,Buffer.alloc(32,9),1n,1n,to),/insufficient circulation/);
 claimQuorum(m,Buffer.alloc(32,51),0n,9900n,recipient);claimQuorum(m,Buffer.alloc(32,52),1n,10000n,recipient);
 for(const [x,y] of [[0n,2000n],[2000n,0n]] as const)assert.throws(()=>m.circuits.addLiquidity(m.context,lpOwner(s1),x,y,0n),/zero liquidity/);
 m.context=m.circuits.addLiquidity(m.context,lpOwner(s1),2000n,2000n,1n).context;
 for(const [x,y] of [[0n,100n],[100n,0n]] as const)assert.throws(()=>m.circuits.addLiquidity(m.context,lpOwner(s2),x,y,0n),/zero liquidity/);
 m.context=m.circuits.addLiquidity(m.context,lpOwner(s2),2000n,2000n,1n).context;
 // s1 owns 1,000 of 4,000 shares: more than owned but less than the total, and zero, both fail.
 assert.throws(()=>m.circuits.removeLiquidity(m.context,s1,1001n,0n,0n,recipient),/insufficient shares/);
 assert.throws(()=>m.circuits.removeLiquidity(m.context,s1,0n,0n,0n,recipient),/insufficient shares/);
 assert.throws(()=>m.circuits.removeLiquidity(m.context,s1,1000n,1001n,0n,recipient),/withdraw slippage/);
 assert.throws(()=>m.circuits.removeLiquidity(m.context,s1,1000n,0n,1001n,recipient),/withdraw slippage/);
 m.context=m.circuits.removeLiquidity(m.context,s1,1000n,1000n,1000n,recipient).context;
 for(const [asset,amount,minOut] of [[0n,0n,1n],[0n,100n,0n],[2n,100n,1n]] as const)assert.throws(()=>m.circuits.swap(m.context,asset,amount,minOut,recipient),/invalid swap/);
});
