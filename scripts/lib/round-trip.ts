import assert from 'node:assert/strict';
import {persistentHash,CompactTypeBytes} from '@midnight-ntwrk/compact-runtime';
import type {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {ledger,pureCircuits} from '../../build/midnight/contract/index.js';
import {Address} from '@ton/core';
import {quoteSwap,type CircuitName} from '../../src/midnight.js';

/** The six demonstration calls, in order, shared by the local and testnet demos and their verifiers. */
const ROUND_TRIP_CIRCUITS:CircuitName[]=['claim','claim','addLiquidity','swap','removeLiquidity','redeem'];
type Recipient={bytes:Uint8Array};
/** Pool and redemption leg after two 10,000-unit claims: add 5,000/5,000 (4,000 LP shares;
 * the contract locks 1,000 bootstrap shares), swap 100, withdraw all 4,000 LP shares, then
 * retire 100 units of asset 0 for `redeemTo`. The LP secret and redemption nonce must already
 * be persisted owner-only (see `stateSecret`), so an interrupted run can resume with the same
 * values; neither enters public evidence. */
export async function poolAndRedeem<R>(record:(circuit:CircuitName,args:unknown[])=>Promise<R>,recipient:Recipient,redeemTo:Uint8Array,secrets:{lp:Buffer;nonce:Buffer}){
 await record('addLiquidity',[persistentHash(new CompactTypeBytes(32),secrets.lp),5000n,5000n,4000n]);
 await record('swap',[0n,100n,quoteSwap(100n,5000n,5000n),recipient]);
 await record('removeLiquidity',[secrets.lp,4000n,0n,0n,recipient]);
 return {id:Buffer.from(pureCircuits.redemptionId(secrets.nonce)),retirement:await record('redeem',[secrets.nonce,0n,100n,redeemTo])};
}
/** Final ledger after a complete round trip: only the locked bootstrap liquidity remains in the
 * pool, 9,900/10,000 circulating, one retirement. */
export function assertRoundTripLedger(data:ReturnType<typeof ledger>){
 assert.deepEqual(data.reserve,[1020n,981n]);assert.deepEqual(data.circulating,[9900n,10000n]);assert.equal(data.totalShares,1000n);assert.equal(data.retired.size(),1n);
}
/** Re-reads each recorded call from the indexer: same circuit order, success and height. */
export async function rereadCalls<T extends {circuit:string;txId:string;blockHeight:number}>(provider:ReturnType<typeof indexerPublicDataProvider>,calls:T[]){
 assert.deepEqual(calls.map(c=>c.circuit),ROUND_TRIP_CIRCUITS);
 const verified:(T&{blockHash:string})[]=[];
 for(const call of calls){const tx=await provider.watchForTxData(call.txId);assert.equal(tx.status,'SucceedEntirely');assert.equal(tx.blockHeight,call.blockHeight);verified.push({...call,blockHash:tx.blockHash});}
 return verified;
}
/** Synthetic TON side of the isolated local demo: no TON chain backs these addresses. */
export const LOCAL_TON_RECIPIENT=new Address(0,Buffer.alloc(32,12));
export const LOCAL_ESCROWS:[string,string]=[new Address(0,Buffer.alloc(32,1)).toRawString(),new Address(0,Buffer.alloc(32,2)).toRawString()];
