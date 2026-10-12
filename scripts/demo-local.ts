import {network,readState,statePath} from '../src/environment.js';
import {writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {addressFromKey} from '@midnight-ntwrk/ledger-v8';
import {syncWallet} from '@midnight-ntwrk/testkit-js';
import {openMidnight} from '../src/live-midnight.js';
import {signClaim,type CircuitName} from '../src/midnight.js';
import {verifyRedemption,type MidnightPins} from '../src/redemptions.js';
import {ledger,pureCircuits} from '../build/midnight/contract/index.js';
import {LOCAL_ESCROWS,LOCAL_TON_RECIPIENT,assertRoundTripLedger,poolAndRedeem} from './lib/round-trip.js';
if(network()!=='local')throw new Error('Synthetic claim demonstration is restricted to the isolated local chain');
const deployment=readState<{address:string;domain:string;network:string;pins:MidnightPins}>('midnight-deployment.json');
if(deployment.network!=='undeployed')throw new Error('not a local deployment');
const keys=readState<string[]>('test-committee.json').map(BigInt);
const client=await openMidnight(),evidence:{circuit:string;txId:string;blockHeight:number;status:string}[]=[];
const recipient={bytes:Buffer.from(addressFromKey(client.wallet.unshieldedKeystore.getPublicKey()),'hex')};
const record=async(circuit:CircuitName,args:unknown[])=>{
 const started=Date.now();const r=await client.call(deployment.address,circuit,args);
 console.log(`${circuit}: proof plus confirmation ${Date.now()-started} ms`);
 evidence.push({circuit,txId:r.public.txId,blockHeight:Number(r.public.blockHeight),status:r.public.status});
 writeFileSync(statePath('local-proof-evidence.json'),JSON.stringify(evidence,null,2));
 console.log(`${circuit}: ${r.public.status} at block ${r.public.blockHeight}`);
 await syncWallet(client.wallet.wallet);
};
const state=async()=>{const s=await client.providers.publicDataProvider.queryContractState(deployment.address);if(!s)throw new Error('contract absent');return s;};
try{
 const before=ledger((await state()).data);if(before.totalShares!==0n||before.circulating.some(n=>n!==0n))throw new Error('Demo needs a fresh contract. Reconcile partial runs instead of blindly replaying.');
 for(const asset of [0n,1n]){
  const id=randomBytes(32),digest=pureCircuits.claimDigest(Buffer.from(deployment.domain,'hex'),Buffer.from(deployment.address,'hex'),id,asset,10000n,recipient);
  await record('claim',[id,asset,10000n,recipient,0n,2n,signClaim(digest,keys[0]!),signClaim(digest,keys[2]!)]);
 }
 const {id}=await poolAndRedeem(record,recipient,LOCAL_TON_RECIPIENT.hash,statePath('demo-lp-secret.json'));
 const snapshot=await state();
 const request={id:id.toString('hex'),asset:0 as const,amount:'100',recipient:LOCAL_TON_RECIPIENT.toRawString(),transactionId:evidence.at(-1)!.txId};
 verifyRedemption(snapshot,deployment.pins,request,LOCAL_ESCROWS);
 writeFileSync(statePath('local-redemption-evidence.json'),JSON.stringify(request,null,2));
 const final=ledger(snapshot.data);assertRoundTripLedger(final);assert(final.retired.member(id));
 console.log('All five circuits finalized; pool emptied and retirement accounting verified. TON leg is separately exercised in the combined sandbox test.');
}finally{await client.close();}
