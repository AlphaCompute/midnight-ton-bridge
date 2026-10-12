import {beginCell,Cell,type Address,type Builder,type Transaction} from '@ton/core';
import {keyPairFromSeed} from '@ton/crypto';
import type {Blockchain} from '@ton/sandbox';
import {compileTon} from '../../scripts/compile-ton.js';
import {OP,DEPOSIT_FORWARD_TON,signTonDigest} from '../../src/ton.js';

/** TON committee: Ed25519 keys from seeds 1, 2, 3. */
export const TON_KEYS=[1,2,3].map(n=>keyPairFromSeed(Buffer.alloc(32,n)));
export const TON_COMMITTEE=TON_KEYS.map(k=>k.publicKey);
const cache=new Map<string,Promise<Cell>>();
/** Compiled contract code, compiled once per test process. */
export const compiled=(name:string)=>{if(!cache.has(name))cache.set(name,compileTon(name).then(r=>Cell.fromBase64(r.codeBoc64)));return cache.get(name)!;};
/** Committee signatures of slots `a` and `b` over a digest. */
export const quorumSign=(digest:Buffer,a=0,b=2)=>[signTonDigest(digest,TON_KEYS[a]!.secretKey),signTonDigest(digest,TON_KEYS[b]!.secretKey)] as const;
export const accountId=(a:Address)=>BigInt('0x'+a.hash.toString('hex'));
/** Compute exit code of the transaction a sent message produced at `account`. */
export const exitOf=(r:{transactions:Transaction[]},account:Address)=>{const d=r.transactions.find(t=>t.address===accountId(account))?.description;return d?.type==='generic'&&d.computePhase.type==='vm'?d.computePhase.exitCode:d?.type==='generic'?'skipped':'absent';};
/** Replace an active account's data; returns a function restoring the original. */
export async function overrideWalletData(chain:Blockchain,address:Address,data:Cell){
 const s=(await chain.getContract(address)).account;if(s.account?.storage.state.type!=='active')throw new Error('inactive account');
 const original=s.account.storage.state.state.data;s.account.storage.state.state.data=data;await chain.setShardAccount(address,s);
 return async()=>{const r=(await chain.getContract(address)).account;if(r.account?.storage.state.type!=='active')throw new Error('inactive account');r.account.storage.state.state.data=original;await chain.setShardAccount(address,r);};
}
/** Hand-built TEP-74 transfer: `payload` writes the forward payload (default: inline `recipient`, or an empty Either). */
export function rawTransfer({query=0n,amount,to,response,forward=DEPOSIT_FORWARD_TON,recipient,payload}:{query?:bigint;amount:bigint;to:Address;response:Address;forward?:bigint;recipient?:Buffer;payload?:(b:Builder)=>Builder}){
 const b=beginCell().storeUint(OP.jettonTransfer,32).storeUint(query,64).storeCoins(amount).storeAddress(to).storeAddress(response).storeBit(false).storeCoins(forward);
 return (payload?payload(b):recipient?b.storeBit(false).storeBuffer(recipient):b.storeBit(false)).endCell();
}
