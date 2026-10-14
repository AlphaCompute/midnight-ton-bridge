import {pureCircuits} from '../build/midnight/contract/index.js';
import {type CircuitName,type SchnorrSignature,quoteSwap,verifyClaim,validPoint} from './midnight.js';
import {type JubjubPoint} from '@midnight-ntwrk/compact-runtime';
import {Address,Cell} from '@ton/core';
import {randomBytes} from 'node:crypto';
import {persistentHash,CompactTypeBytes} from '@midnight-ntwrk/compact-runtime';
import {type DepositReceipt} from './escrow.js';
import {assertAsset,transferBody,u64,positiveUint64,DEPOSIT_ATTACHED_TON} from './ton.js';
import {referenceWallet} from './jettons.js';
import {parseMidnightRecipient} from './midnight-address.js';
import {hex32 as bytes} from './encoding.js';
import type {TestNetwork} from './environment.js';
export {DEPOSIT_ATTACHED_TON} from './ton.js';

/** Token pins for one asset: its jetton master and the reference wallet code it deploys. */
export type BridgeAsset={master:string;walletCodeBoc:string;walletCodeHash:string};
/** `assets` (in asset order) is required for `depositRequest`, which must know the sender's
 * own jetton wallet for each token. */
export type BridgeConfig={network:TestNetwork;domain:string;midnightAddress:string;escrows:[string,string];committee:[JubjubPoint,JubjubPoint,JubjubPoint];assets?:[BridgeAsset,BridgeAsset]};
/** LP share owner key for a private LP secret, as the contract computes it on withdrawal. */
export const lpOwnerHash=(lpSecret:string)=>Buffer.from(persistentHash(new CompactTypeBytes(32),bytes(lpSecret))).toString('hex');
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
  if(config.assets){
   if(config.assets.length!==2)throw new Error('assets must pin both tokens');
   for(const a of config.assets){if(Address.parse(a.master).workChain!==0||Cell.fromBase64(a.walletCodeBoc).hash().toString('hex')!==a.walletCodeHash.toLowerCase())throw new Error('invalid asset pin');}
  }
 }
 /** Complete deposit: send `payload` to `to` (the sender's own jetton wallet for this token)
  * with `value` nanotons attached. Sending it from any other wallet, or to the escrow
  * directly, strands the tokens where the escrow cannot recover them. */
 depositRequest(asset:0|1,owner:string,amount:bigint,midnightRecipient:string,queryId:bigint=randomBytes(8).readBigUInt64BE()>>1n){
  assertAsset(asset);const pin=this.config.assets?.[asset];if(!pin)throw new Error('BridgeConfig.assets is required to locate the jetton wallet');
  const from=Address.parse(owner),to=referenceWallet(from,Address.parse(pin.master),Cell.fromBase64(pin.walletCodeBoc)).address;
  return {to:to.toString({testOnly:this.config.network!=='local',bounceable:true}),value:DEPOSIT_ATTACHED_TON,queryId,payload:this.depositMessage(asset,amount,midnightRecipient,owner,queryId)};
 }
 /** Low-level jetton transfer body only; prefer `depositRequest`, which also names the
  * wallet to send it from. The recipient may be an mn_addr… address or 32-byte hex. */
 depositMessage(asset:0|1,amount:bigint,midnightRecipient:string,tonSender:string,queryId:bigint){
  assertAsset(asset);
  return transferBody(queryId,amount,Address.parse(this.config.escrows[asset]),Address.parse(tonSender),parseMidnightRecipient(midnightRecipient,this.config.network));
 }
 claimDigest(receipt:DepositReceipt){
  if(receipt.network!=='ton-testnet'||!['0','1'].includes(String(receipt.asset)))throw new Error('invalid route');
  if(Address.parse(receipt.escrow).toRawString()!==Address.parse(this.config.escrows[receipt.asset]).toRawString())throw new Error('wrong escrow');
  const amount=positiveUint64(BigInt(receipt.amount));
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
 /** Retires `amount` for release to `tonRecipient` on TON. A fresh private nonce is drawn
  * unless given; keep it private until the redemption is final (only its hash `id` is
  * published, so nobody can retire the same ID first). Give the committee `request`. */
 async redeem(asset:0|1,amount:bigint,tonRecipient:string,nonce:string=randomBytes(32).toString('hex')){
  assertAsset(asset);positiveUint64(amount);
  const recipient=Address.parse(tonRecipient);if(recipient.workChain!==0)throw new Error('only TON basechain supported');
  // The escrow refuses to release to itself; retired tokens would wait on that refusal.
  const escrows=this.config.escrows.map(e=>Address.parse(e)),pins=this.config.assets;
  const wallets=pins?escrows.map((e,i)=>referenceWallet(e,Address.parse(pins[i]!.master),Cell.fromBase64(pins[i]!.walletCodeBoc)).address):[];
  if([...escrows,...wallets].some(a=>a.equals(recipient)))throw new Error('TON recipient cannot be a bridge escrow or its jetton wallet');
  const id=this.redemptionId(nonce),transactionId=await this.transport.call('redeem',[bytes(nonce),BigInt(asset),amount,recipient.hash]);
  return {nonce,id,transactionId,request:{id,asset,amount:amount.toString(),recipient:recipient.toRawString(),transactionId}};
 }
 quote(input:bigint,reserveIn:bigint,reserveOut:bigint){return quoteSwap(input,reserveIn,reserveOut);}
 swap(asset:0|1,amount:bigint,minOut:bigint,recipient:string){assertAsset(asset);positiveUint64(amount);positiveUint64(minOut);return this.transport.call('swap',[BigInt(asset),amount,minOut,{bytes:parseMidnightRecipient(recipient,this.config.network)}]);}
 /** Takes the private LP secret (back it up first); only its hash is sent. `removeLiquidity`
  * needs the same secret. The first deposit mints 1,000 fewer shares, locked forever. */
 addLiquidity(lpSecret:string,x:bigint,y:bigint,minShares:bigint){positiveUint64(x);positiveUint64(y);positiveUint64(minShares);return this.transport.call('addLiquidity',[Buffer.from(lpOwnerHash(lpSecret),'hex'),x,y,minShares]);}
 removeLiquidity(lpSecret:string,shares:bigint,minX:bigint,minY:bigint,recipient:string){positiveUint64(shares);u64(minX);u64(minY);return this.transport.call('removeLiquidity',[bytes(lpSecret),shares,minX,minY,{bytes:parseMidnightRecipient(recipient,this.config.network)}]);}
}
