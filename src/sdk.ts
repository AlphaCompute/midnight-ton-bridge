import {pureCircuits} from '../build/midnight/contract/index.js';
import {type CircuitName,type SchnorrSignature,quoteSwap,verifyClaim,validPoint} from './midnight.js';
import {type JubjubPoint} from '@midnight-ntwrk/compact-runtime';
import {Address} from '@ton/core';
import {type DepositReceipt} from './escrow.js';
import {assertAsset,transferBody,u64,uint64} from './ton.js';
import {hex32 as bytes} from './encoding.js';
import type {TestNetwork} from './environment.js';
export {DEPOSIT_ATTACHED_TON} from './ton.js';

export type BridgeConfig={network:TestNetwork;domain:string;midnightAddress:string;escrows:[string,string];committee:[JubjubPoint,JubjubPoint,JubjubPoint]};
export type ClaimAttestation={signer:0|1|2;signature:SchnorrSignature};
export interface MidnightTransport {
 /** Return a transaction identifier. The client never interprets it as finality. */
 call(circuit:CircuitName,args:unknown[]):Promise<string>;
}
export class BridgeClient {
 constructor(readonly config:BridgeConfig,private readonly transport:MidnightTransport){
  if(config.network!=='local'&&config.network!=='preprod')throw new Error('mainnet is not supported');
  bytes(config.domain);bytes(config.midnightAddress);
  if(config.escrows.length!==2||config.committee.length!==3)throw new Error('invalid routes or committee');
  config.escrows.forEach(a=>{if(Address.parse(a).workChain!==0)throw new Error('only basechain escrows supported');});
  if(new Set(config.escrows.map(a=>Address.parse(a).toRawString())).size!==2)throw new Error('asset escrows must differ');
  if(config.committee.some(p=>!validPoint(p)))throw new Error('invalid committee point');
  if(new Set(config.committee.map(p=>`${p.x}:${p.y}`)).size!==3)throw new Error('duplicate committee');
 }
 depositMessage(asset:0|1,amount:bigint,midnightRecipient:string,tonSender:string,queryId:bigint){
  assertAsset(asset);
  return transferBody(queryId,amount,Address.parse(this.config.escrows[asset]),Address.parse(tonSender),bytes(midnightRecipient));
 }
 claimDigest(receipt:DepositReceipt){
  if(receipt.network!=='ton-testnet'||!['0','1'].includes(String(receipt.asset)))throw new Error('invalid route');
  if(Address.parse(receipt.escrow).toRawString()!==Address.parse(this.config.escrows[receipt.asset]).toRawString())throw new Error('wrong escrow');
  const amount=uint64(BigInt(receipt.amount));
  return pureCircuits.claimDigest(bytes(this.config.domain),bytes(this.config.midnightAddress),bytes(receipt.id),BigInt(receipt.asset),amount,{bytes:bytes(receipt.recipient)});
 }
 async claim(receipt:DepositReceipt,attestations:ClaimAttestation[]){
  const digest=this.claimDigest(receipt),sorted=[...attestations].sort((a,b)=>a.signer-b.signer);
  if(sorted.length!==2||sorted[0]!.signer>=sorted[1]!.signer)throw new Error('two distinct signers required');
  for(const a of sorted){const pk=this.config.committee[a.signer];if(!pk||!verifyClaim(digest,pk,a.signature))throw new Error('invalid attestation');}
  return this.transport.call('claim',[bytes(receipt.id),BigInt(receipt.asset),BigInt(receipt.amount),{bytes:bytes(receipt.recipient)},BigInt(sorted[0]!.signer),BigInt(sorted[1]!.signer),sorted[0]!.signature,sorted[1]!.signature]);
 }
 /** Public retirement ID (and TON release receipt) for a redemption nonce. */
 redemptionId(nonce:string){return Buffer.from(pureCircuits.redemptionId(bytes(nonce))).toString('hex');}
 /** Use a fresh random nonce and keep it private until the redemption is final: only
  * its hash is published, so nobody else can retire the same ID first. */
 redeem(nonce:string,asset:0|1,amount:bigint,tonRecipient:string){
  assertAsset(asset);uint64(amount);
  const recipient=Address.parse(tonRecipient);if(recipient.workChain!==0)throw new Error('only TON basechain supported');
  return this.transport.call('redeem',[bytes(nonce),BigInt(asset),amount,recipient.hash]);
 }
 quote(input:bigint,reserveIn:bigint,reserveOut:bigint){return quoteSwap(input,reserveIn,reserveOut);}
 swap(asset:0|1,amount:bigint,minOut:bigint,recipient:string){assertAsset(asset);uint64(amount);uint64(minOut);return this.transport.call('swap',[BigInt(asset),amount,minOut,{bytes:bytes(recipient)}]);}
 addLiquidity(lpOwner:string,x:bigint,y:bigint,minShares:bigint){uint64(x);uint64(y);uint64(minShares);return this.transport.call('addLiquidity',[bytes(lpOwner),x,y,minShares]);}
 removeLiquidity(secret:string,shares:bigint,minX:bigint,minY:bigint,recipient:string){uint64(shares);u64(minX);u64(minY);return this.transport.call('removeLiquidity',[bytes(secret),shares,minX,minY,{bytes:bytes(recipient)}]);}
}
