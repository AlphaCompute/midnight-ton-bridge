import type {Address,Cell} from '@ton/core';
import {depositId} from './escrow.js';
import type {Mailbox} from './mailbox.js';
import type {BridgeClient,ClaimAttestation} from './sdk.js';
import type {DepositReceipt} from './escrow.js';
import type {RedemptionRequest} from './redemptions.js';
import type {DepositAttestation,ReleaseAttestation} from './attest.js';
import {claimQuorum,releaseQuorum,type TonRelayConfig} from './quorum.js';

// One pass of the automated signer and relayer. Chain access is injected, so the scripts
// supply live clients and tests supply in-memory chains. A pass never retries a send whose
// outcome is unknown: the journals behind `submitClaim`/`sendRelease` refuse while any
// earlier transaction is unreconciled, and that refusal is reported like any other error.

export type Log=(event:string,fields?:Record<string,unknown>)=>void;
export type DepositSource={escrow:string;
 /** Number of deposits the escrow has recorded, at a finalized snapshot. */
 count():Promise<bigint>;
 attest(sequence:bigint):Promise<DepositAttestation>};
export type SignerDeps={mailbox:Mailbox;signer:number;deposits:DepositSource[];
 /** Whether Midnight has already accepted this receipt; such deposits need no new signature. */
 claimed(receiptId:string):Promise<boolean>;
 redemption?:{released(request:RedemptionRequest):Promise<boolean>;attest(request:RedemptionRequest):Promise<ReleaseAttestation>};
 log:Log};
/** Signs every finalized, unclaimed deposit and every queued, unreleased redemption that this
 * signer has not yet published. Each item is independent: one failure does not stop the pass. */
export async function signerPass(d:SignerDeps){
 let signed=0;
 for(const source of d.deposits){
  let count:bigint;
  try{count=await source.count();}catch(error){d.log('deposit-count-failed',{escrow:source.escrow,error:String(error)});continue;}
  for(let sequence=0n;sequence<count;sequence++){
   const id=depositId(source.escrow,sequence);
   if(d.mailbox.has('claims',id,d.signer))continue;
   try{
    if(await d.claimed(id))continue;
    const attestation=await source.attest(sequence);
    if(d.mailbox.post('claims',attestation.receipt.id,d.signer,attestation)){signed++;d.log('deposit-signed',{id,sequence:String(sequence),amount:attestation.receipt.amount});}
   }catch(error){d.log('deposit-sign-failed',{id,sequence:String(sequence),error:String(error)});}
  }
 }
 if(d.redemption)for(const request of d.mailbox.requests()){
  if(d.mailbox.has('releases',request.id,d.signer))continue;
  try{
   if(await d.redemption.released(request))continue;
   const attestation=await d.redemption.attest(request);
   if(d.mailbox.post('releases',request.id,d.signer,attestation)){signed++;d.log('redemption-signed',{id:request.id,amount:request.amount});}
  }catch(error){d.log('redemption-sign-failed',{id:request.id,error:String(error)});}
 }
 return signed;
}
export type RelayerDeps={mailbox:Mailbox;bridge:BridgeClient;ton?:TonRelayConfig;
 claimed(receiptId:string):Promise<boolean>;
 submitClaim(receipt:DepositReceipt,attestations:[ClaimAttestation,ClaimAttestation]):Promise<string>;
 /** Escrow `releaseState(id)`: non-zero once the escrow accepted a release for it. */
 releaseState(escrow:Address,id:string):Promise<number>;
 sendRelease(escrow:Address,body:Cell,journalId:string):Promise<unknown>;
 /** Ids this process already submitted, kept across passes so a lagging read cannot trigger
  * a duplicate submission. */
 done?:Set<string>;
 log:Log};
/** Submits each claim and release that has a valid two-signer quorum and has not yet been
 * accepted on chain. Quorums are re-verified from the files on every pass. */
export async function relayerPass(d:RelayerDeps){
 let relayed=0;
 for(const [id,entries] of d.mailbox.entries('claims')){
  if(d.done?.has('claim:'+id))continue;
  try{
   if(await d.claimed(id))continue;
   const quorum=claimQuorum(d.bridge,entries);if(!quorum)continue;
   if(quorum.receipt.id.toLowerCase()!==id)throw new Error('attestations are filed under another receipt');
   const tx=await d.submitClaim(quorum.receipt,quorum.attestations);d.done?.add('claim:'+id);relayed++;
   d.log('claim-submitted',{id,transaction:tx,signers:quorum.attestations.map(a=>a.signer)});
  }catch(error){d.log('claim-failed',{id,error:String(error)});}
 }
 if(d.ton)for(const [id,entries] of d.mailbox.entries('releases')){
  if(d.done?.has('release:'+id))continue;
  try{
   const release=releaseQuorum(d.ton,entries);if(!release)continue;
   if(release.id!==id)throw new Error('attestations are filed under another redemption');
   if(await d.releaseState(release.escrow,release.id)!==0)continue;
   const result=await d.sendRelease(release.escrow,release.body,release.journalId);d.done?.add('release:'+id);relayed++;
   d.log('release-submitted',{id,escrow:release.escrow.toRawString(),result});
  }catch(error){d.log('release-failed',{id,error:String(error)});}
 }
 return relayed;
}
/** Log function writing one JSON line per event, suppressing an identical repeat of the
 * previous event for the same id so a persistent failure does not flood the log. */
export function jsonLog(role:string,write:(line:string)=>void=l=>console.log(l)):Log{
 const last=new Map<string,string>();
 return (event,fields={})=>{
  const key=String(fields.id??event),sig=event+JSON.stringify(fields);
  if(last.get(key)===sig)return;last.set(key,sig);
  write(JSON.stringify({time:new Date().toISOString(),role,event,...fields}));
 };
}
