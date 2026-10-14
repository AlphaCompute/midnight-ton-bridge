import {Address,type Cell} from '@ton/core';
import {signVerify} from '@ton/crypto';
import {BridgeClient,type ClaimAttestation} from './sdk.js';
import type {DepositReceipt} from './escrow.js';
import type {RedemptionRequest} from './redemptions.js';
import {verifyClaim} from './midnight.js';
import {releaseBody,releaseDigest} from './ton.js';
import {HEX32} from './encoding.js';

// Selects two agreeing, valid committee signatures from untrusted attestation files. Every
// entry is re-verified here; a relayer never trusts who wrote a file or what it claims.

export type TonAttestation={signer:number;signature:string};
/** Two attestations from distinct committee slots, ascending, each signing `digest`. */
export function tonQuorum<T extends TonAttestation>(entries:T[],committee:string[],digest:Buffer){
 const [a,b]=[...entries].sort((x,y)=>x.signer-y.signer);
 if(!a||!b||!Number.isInteger(a.signer)||!Number.isInteger(b.signer)||a.signer<0||a.signer>=b.signer||b.signer>2)throw new Error('invalid quorum');
 for(const e of [a,b])if(!signVerify(digest,Buffer.from(e.signature,'hex'),Buffer.from(committee[e.signer]??'','hex')))throw new Error('invalid signature');
 return {a,b,sigA:Buffer.from(a.signature,'hex'),sigB:Buffer.from(b.signature,'hex')};
}
/** The fields a claim commits to; observers may differ only in the snapshot they read. */
export const canonicalReceipt=(r:DepositReceipt)=>JSON.stringify([r.id,r.network,Address.parse(r.escrow).toRawString(),r.sequence,r.asset,r.amount,r.recipient]);
/** Revives a JSON claim attestation's bigint fields. */
export function parseClaimAttestation(a:ClaimAttestation):ClaimAttestation{
 const s=a.signature;
 return {signer:a.signer,signature:{response:BigInt(s.response),announcement:{x:BigInt(s.announcement.x),y:BigInt(s.announcement.y)}}};
}
/** Two valid signatures from distinct slots over the same receipt, or null when there is no
 * quorum yet. Invalid or disagreeing entries are ignored, never trusted. */
export function claimQuorum(bridge:BridgeClient,entries:unknown[]):{receipt:DepositReceipt;attestations:[ClaimAttestation,ClaimAttestation]}|null{
 const groups=new Map<string,{receipt:DepositReceipt;bySigner:Map<number,ClaimAttestation>}>();
 for(const entry of entries){
  try{
   const {receipt,attestation}=entry as {receipt:DepositReceipt;attestation:ClaimAttestation};
   const parsed=parseClaimAttestation(attestation),pk=bridge.config.committee[parsed.signer];
   if(!Number.isInteger(parsed.signer)||!pk||!verifyClaim(bridge.claimDigest(receipt),pk,parsed.signature))continue;
   const key=canonicalReceipt(receipt),group=groups.get(key)??{receipt,bySigner:new Map()};
   group.bySigner.set(parsed.signer,parsed);groups.set(key,group);
  }catch{/* malformed entries are ignored */}
 }
 for(const {receipt,bySigner} of groups.values()){
  const [a,b]=[...bySigner.values()].sort((x,y)=>x.signer-y.signer);
  if(a&&b)return {receipt,attestations:[a,b]};
 }
 return null;
}
export type TonRelayConfig={network:string;domain:string;escrows:[string,string];committee:string[];walletKeyFile:string};
export type PreparedRelease={escrow:Address;id:string;request:RedemptionRequest;body:Cell;journalId:string};
/** Checks a release request's shape and returns its escrow, id, amount and recipient. */
export function releaseTarget(config:TonRelayConfig,r:RedemptionRequest){
 if(r.asset!==0&&r.asset!==1)throw new Error('invalid asset');
 if(!HEX32.test(r.id))throw new Error('invalid redemption id');
 return {escrow:Address.parse(config.escrows[r.asset]),recipient:Address.parse(r.recipient),amount:BigInt(r.amount),id:Buffer.from(r.id,'hex')};
}
/** The release message for two valid signatures over the same request, or null. */
export function releaseQuorum(config:TonRelayConfig,entries:unknown[]):PreparedRelease|null{
 const groups=new Map<string,{request:RedemptionRequest;bySigner:Map<number,TonAttestation>}>();
 for(const entry of entries){
  try{
   const e=entry as TonAttestation&{request:RedemptionRequest},t=releaseTarget(config,e.request);
   const digest=releaseDigest(t.escrow,Buffer.from(config.domain,'hex'),t.id,t.amount,t.recipient);
   if(!Number.isInteger(e.signer)||!signVerify(digest,Buffer.from(e.signature,'hex'),Buffer.from(config.committee[e.signer]??'','hex')))continue;
   const key=JSON.stringify([e.request.id.toLowerCase(),e.request.asset,t.amount.toString(),t.recipient.toRawString()]);
   const group=groups.get(key)??{request:e.request,bySigner:new Map()};group.bySigner.set(e.signer,e);groups.set(key,group);
  }catch{/* malformed entries are ignored */}
 }
 for(const {request,bySigner} of groups.values()){
  const [a,b]=[...bySigner.values()].sort((x,y)=>x.signer-y.signer);if(!a||!b)continue;
  const t=releaseTarget(config,request);
  const body=releaseBody(t.id,t.amount,t.recipient,a.signer,b.signer,Buffer.from(a.signature,'hex'),Buffer.from(b.signature,'hex'));
  return {escrow:t.escrow,id:request.id.toLowerCase(),request,body,journalId:`release:${t.escrow.toRawString()}:${request.id.toLowerCase()}`};
 }
 return null;
}
