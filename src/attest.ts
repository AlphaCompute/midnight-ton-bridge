import {Address} from '@ton/core';
import type {TonClient4} from '@ton/ton';
import {keyPairFromSeed} from '@ton/crypto';
import type {ContractState} from '@midnight-ntwrk/compact-runtime';
import {authorizeSignature,type SigningPolicy} from './signer-policy.js';
import {readSecret,type TestNetwork} from './environment.js';
import {verifyingKey,signClaim} from './midnight.js';
import {observeTonDeposit,verifyEscrowPins,type DepositReceipt,type EscrowPins} from './escrow.js';
import {BridgeClient,type BridgeConfig,type ClaimAttestation} from './sdk.js';
import {verifyRedemption,type MidnightPins,type RedemptionRequest} from './redemptions.js';
import {signTonDigest} from './ton.js';
import {finalizedBlock} from './ton-network.js';

/** Committee member signing identity: its slot, owner-only key file and signing policy. */
export type Signer={signer:number;keyFile:string;policy:SigningPolicy};
export type DepositSignerConfig=Signer&{rpc:string;source:EscrowPins&{asset:0|1;master:string;confirmationDepth:number};bridge:BridgeConfig};
export type RedemptionSignerConfig=Signer&{network:TestNetwork;indexer?:string;indexerWS?:string;node?:string;tonRpc?:string;address:string;pins:MidnightPins;escrows:[EscrowPins&{master:string},EscrowPins&{master:string}];committee:string[]};
/** Public output of `attest-deposit`: the observed receipt and one Midnight Schnorr signature. */
export type DepositAttestation={receipt:DepositReceipt;attestation:ClaimAttestation};
/** Public output of `attest-redemption`: the request and one TON Ed25519 signature. */
export type ReleaseAttestation={request:RedemptionRequest;blockHash:string;blockHeight:number;signer:number;signature:string};

export const checkSlot=(signer:number)=>{if(!Number.isInteger(signer)||signer<0||signer>2)throw new Error('signer must be committee index 0, 1 or 2');};
/** Bridge configuration read from JSON, with its committee points as bigints. */
export function parseBridgeConfig(config:BridgeConfig):BridgeConfig{
 return {...config,committee:config.committee.map(p=>({x:BigInt(p.x),y:BigInt(p.y)})) as BridgeConfig['committee']};
}
/** This operator's TON key, after checking it occupies its configured committee slot. */
export function tonSigner(c:Signer,committee:string[]){
 checkSlot(c.signer);const key=keyPairFromSeed(Buffer.from(readSecret<{tonSeed:string}>(c.keyFile).tonSeed,'hex'));
 if(committee[c.signer]!==key.publicKey.toString('hex'))throw new Error('signer key does not match TON committee slot');return key;
}
/** Observes TON deposit `sequence` at a finalized snapshot and signs its claim digest. */
export async function attestDeposit(config:DepositSignerConfig,ton:TonClient4,sequence:bigint):Promise<DepositAttestation>{
 checkSlot(config.signer);const bridge=parseBridgeConfig(config.bridge);
 // The code/config pins only prove the config agrees with itself. The escrow's on-chain
 // configuration must also belong to this route (domain) and hold this asset's token, or a
 // stale or swapped config could mint on one route for a deposit locked on another.
 if(!config.source.master)throw new Error('source.master must pin the token master for this asset');
 const receipt=await observeTonDeposit(ton,config.source,sequence);
 const onChain=await verifyEscrowPins(ton,receipt.block,config.source);
 if(onChain.domain!==bridge.domain.toLowerCase()||!onChain.master.equals(Address.parse(config.source.master)))throw new Error('Escrow does not belong to this route and token');
 const client=new BridgeClient(bridge,{call:async()=>{throw new Error('signer never submits');}});
 const secret=readSecret<{midnight:string}>(config.keyFile);
 const own=verifyingKey(BigInt(secret.midnight)),expected=bridge.committee[config.signer];
 if(!expected||own.x!==expected.x||own.y!==expected.y)throw new Error('signer key does not match committee slot');
 const digest=client.claimDigest(receipt);
 // Keyed by the TON deposit alone: one deposit can be attested once, whatever the route.
 authorizeSignature(config.policy,`deposit:${receipt.id.toLowerCase()}`,Buffer.from(digest).toString('hex'),BigInt(receipt.amount));
 return {receipt,attestation:{signer:config.signer as 0|1|2,signature:signClaim(digest,BigInt(secret.midnight))}};
}
/** Chain reads a redemption attestation needs, each from this operator's own endpoints. */
export type RedemptionReads={
 /** Finalized, successful transaction data for `transactionId`. */
 transaction(transactionId:string):Promise<{status:string;blockHeight:number;blockHash:string}>;
 /** Throws unless the node reports the block as finalized and canonical. */
 assertFinalized(blockHeight:number,blockHash:string):Promise<void>;
 /** Contract state at exactly that block. */
 stateAt(blockHash:string):Promise<ContractState|null>;
 ton:TonClient4;
};
/** Verifies a finalized Midnight retirement and both route escrows, then signs its TON release. */
export async function attestRedemption(config:RedemptionSignerConfig,reads:RedemptionReads,request:RedemptionRequest):Promise<ReleaseAttestation>{
 if(config.network!=='local'&&config.network!=='preprod')throw new Error('test networks only');
 const key=tonSigner(config,config.committee);
 const tx=await reads.transaction(request.transactionId);if(tx.status!=='SucceedEntirely')throw new Error('transaction failed');
 await reads.assertFinalized(tx.blockHeight,tx.blockHash);
 const state=await reads.stateAt(tx.blockHash);if(!state)throw new Error('contract not found');
 // The release goes to escrows[asset]. Confirm on chain that each pinned escrow belongs to
 // this route and committee and holds the expected token, so a swapped config cannot pay
 // one asset for a retirement of the other.
 if(config.escrows?.length!==2)throw new Error('escrows must pin both asset escrows');
 const {block}=await finalizedBlock(reads.ton);
 for(const pin of config.escrows){
  const onChain=await verifyEscrowPins(reads.ton,block,pin);
  if(onChain.domain!==config.pins.domain||onChain.committee.join()!==config.committee.join()||!onChain.master.equals(Address.parse(pin.master)))throw new Error(`Escrow ${pin.escrow} does not belong to this route, committee and token`);
 }
 const digest=verifyRedemption(state,config.pins,request,[config.escrows[0].escrow,config.escrows[1].escrow]);
 authorizeSignature(config.policy,`release:${config.address.toLowerCase()}:${request.id.toLowerCase()}`,digest.toString('hex'),BigInt(request.amount));
 return {request,blockHash:tx.blockHash,blockHeight:tx.blockHeight,signer:config.signer,signature:signTonDigest(digest,key.secretKey).toString('hex')};
}
