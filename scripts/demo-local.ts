import {readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {addressFromKey} from '@midnight-ntwrk/ledger-v8';
import {syncWallet} from '@midnight-ntwrk/testkit-js';
import {persistentHash,CompactTypeBytes} from '@midnight-ntwrk/compact-runtime';
import {openMidnight} from '../src/live-midnight.js';
import {signClaim,quoteSwap} from '../src/midnight.js';
import {verifyRedemption} from '../src/redemptions.js';
import type {MidnightPins} from '../src/redemptions.js';
import {Address} from '@ton/core';
import {ledger,pureCircuits} from '../build/midnight/contract/index.js';
if((process.env.MIDNIGHT_NETWORK??'local')!=='local')throw new Error('Synthetic claim demonstration is restricted to the isolated local chain');
const deployment=JSON.parse(readFileSync('.state/midnight-deployment.json','utf8')) as {address:string;domain:string;network:string;pins:MidnightPins};
if(deployment.network!=='undeployed')throw new Error('not a local deployment');
const keys=(JSON.parse(readFileSync('.state/test-committee.json','utf8')) as string[]).map(BigInt);
const client=await openMidnight(),evidence:{circuit:string;txId:string;blockHeight:number;status:string}[]=[];
const recipient={bytes:Buffer.from(addressFromKey(client.wallet.unshieldedKeystore.getPublicKey()),'hex')};
const record=async(circuit:Parameters<typeof client.call>[1],args:unknown[])=>{
 const started=Date.now();const r=await client.call(deployment.address,circuit,args);
 console.log(`${circuit}: proof plus confirmation ${Date.now()-started} ms`);
 evidence.push({circuit,txId:r.public.txId,blockHeight:Number(r.public.blockHeight),status:r.public.status});
 writeFileSync('.state/local-proof-evidence.json',JSON.stringify(evidence,null,2));
 console.log(`${circuit}: ${r.public.status} at block ${r.public.blockHeight}`);
 await syncWallet(client.wallet.wallet);
};
const state=async()=>{const s=await client.providers.publicDataProvider.queryContractState(deployment.address);if(!s)throw new Error('contract absent');return ledger(s.data);};
try{
 const before=await state();if(before.totalShares!==0n||before.circulating.some(n=>n!==0n))throw new Error('Demo needs a fresh contract. Reconcile partial runs instead of blindly replaying.');
 for(const asset of [0n,1n]){
  const id=randomBytes(32),digest=pureCircuits.claimDigest(Buffer.from(deployment.domain,'hex'),Buffer.from(deployment.address,'hex'),id,asset,10000n,recipient);
  await record('claim',[id,asset,10000n,recipient,0n,2n,signClaim(digest,keys[0]!),signClaim(digest,keys[2]!)]);
 }
 const secret=randomBytes(32),owner=persistentHash(new CompactTypeBytes(32),secret);
 // Persist LP authority before submission, never put it in public evidence.
 writeFileSync('.state/demo-lp-secret.json',JSON.stringify({secret:secret.toString('hex')}),{mode:0o600,flag:'wx'});
 await record('addLiquidity',[owner,5000n,5000n,5000n]);
 const out=quoteSwap(100n,5000n,5000n);
 await record('swap',[0n,100n,out,recipient]);
 await record('removeLiquidity',[secret,5000n,0n,0n,recipient]);
 const redemption=randomBytes(32);await record('redeem',[redemption,0n,100n,Buffer.alloc(32,12)]);
 const snapshot=await client.providers.publicDataProvider.queryContractState(deployment.address);if(!snapshot)throw new Error('missing final state');
 const request={id:redemption.toString('hex'),asset:0 as const,amount:'100',recipient:new Address(0,Buffer.alloc(32,12)).toRawString(),transactionId:evidence.at(-1)!.txId};
 verifyRedemption(snapshot,deployment.pins,request,[new Address(0,Buffer.alloc(32,1)).toRawString(),new Address(0,Buffer.alloc(32,2)).toRawString()]);
 writeFileSync('.state/local-redemption-evidence.json',JSON.stringify(request,null,2));
 const final=await state();assert.deepEqual(final.reserve,[0n,0n]);assert.equal(final.totalShares,0n);assert.deepEqual(final.circulating,[9900n,10000n]);assert(final.retired.member(redemption));
 console.log('All five circuits finalized; pool emptied and retirement accounting verified. TON leg is separately exercised in the combined sandbox test.');
}finally{await client.close();}
