import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Address} from '@ton/core';
import {BridgeClient,lpOwnerHash,type BridgeConfig} from '../src/sdk.js';
import {signClaim} from '../src/midnight.js';
import {depositId,type DepositReceipt} from '../src/escrow.js';
import {ecMulGenerator} from '@midnight-ntwrk/compact-runtime';
import {referenceWallet} from '../src/jettons.js';
import {MIDNIGHT_SECRETS,midnightCommittee} from './helpers/midnight.js';
import {compiled} from './helpers/ton.js';
const escrows:[string,string]=[new Address(0,Buffer.alloc(32,1)).toRawString(),new Address(0,Buffer.alloc(32,2)).toRawString()];
const config:BridgeConfig={network:'local',domain:'aa'.repeat(32),midnightAddress:'bb'.repeat(32),escrows,committee:midnightCommittee()};
test('SDK validates route, signs actual circuit digest, and rejects invalid boundaries',async()=>{
 let calls=0;const client=new BridgeClient(config,{call:async(c,args)=>{calls++;assert.equal(c,'claim');assert.equal(args[2],100n);return 'tx-id';}});
 const receipt:DepositReceipt={id:depositId(escrows[0],0n),network:'ton-testnet',escrow:escrows[0],sequence:'0',asset:0,amount:'100',recipient:'cc'.repeat(32),block:10,blockRoot:'source-block'};
 const d=client.claimDigest(receipt),a={signer:0 as const,signature:signClaim(d,MIDNIGHT_SECRETS[0])},b={signer:2 as const,signature:signClaim(d,MIDNIGHT_SECRETS[2])};
 assert.equal(await client.claim(receipt,[b,a]),'tx-id');assert.equal(calls,1);
 await assert.rejects(client.claim(receipt,[a,a]),/distinct/);
 await assert.rejects(client.claim({...receipt,amount:'101'},[a,b]),/invalid attestation/);
 assert.throws(()=>client.claimDigest({...receipt,escrow:escrows[1]}),/wrong escrow/);
 assert.throws(()=>client.depositMessage(0,0n,receipt.recipient,escrows[0],1n),/positive/);
 await assert.rejects(()=>client.redeem(0,1n,new Address(-1,Buffer.alloc(32,1)).toRawString()),/basechain/);
 await assert.rejects(()=>client.redeem(0,1n,escrows[1]),/escrow/);
 assert.throws(()=>client.swap(0,1n,0n,receipt.recipient),/positive/);
 assert.throws(()=>new BridgeClient({...config,escrows:[escrows[0],escrows[0]]},{call:async()=>''}),/differ/);
 // A zero or malformed Midnight recipient is refused before any message is built.
 assert.throws(()=>client.depositMessage(0,1n,'00'.repeat(32),escrows[0],1n),/all-zero/);
 assert.throws(()=>client.depositMessage(0,1n,'mn_addr_preprod1nope',escrows[0],1n),/mn_addr/);
 // Without token pins the SDK cannot name the jetton wallet, so it refuses to guess.
 assert.throws(()=>client.depositRequest(0,escrows[0],1n,receipt.recipient),/assets is required/);
 // The LP owner key is the contract's hash of the secret, never the secret itself.
 assert.notEqual(lpOwnerHash('11'.repeat(32)),'11'.repeat(32));assert.match(lpOwnerHash('11'.repeat(32)),/^[0-9a-f]{64}$/);
 assert.equal(calls,1);
});

test('SDK refuses mainnet and invalid or repeated committee keys',()=>{
 const make=(c:Partial<BridgeConfig>)=>new BridgeClient({...config,...c},{call:async()=>''});
 const [k0,k1,k2]=midnightCommittee(),torsion={x:0n,y:52435875175126190479447740508185965837690552500527637822603658699938581184512n};
 assert.throws(()=>make({network:'mainnet' as never}),/mainnet/);
 for(const p of [ecMulGenerator(0n),torsion,{x:1n,y:1n}])assert.throws(()=>make({committee:[k0,p,k2]}),/invalid committee point/);
 for(const committee of [[k0,k0,k1],[k0,k1,k1],[k0,k1,k0]] as const)assert.throws(()=>make({committee:[...committee]}),/duplicate committee/);
 make({});
});

test('SDK deposit request targets the owner\'s reference jetton wallet and pins its code',async()=>{
 const wc=await compiled('reference-wallet'),masters=[new Address(0,Buffer.alloc(32,7)),new Address(0,Buffer.alloc(32,8))];
 const pin=(m:Address)=>({master:m.toRawString(),walletCodeBoc:wc.toBoc().toString('base64'),walletCodeHash:wc.hash().toString('hex')});
 const assets:[ReturnType<typeof pin>,ReturnType<typeof pin>]=[pin(masters[0]!),pin(masters[1]!)],owner=new Address(0,Buffer.alloc(32,9));
 const client=new BridgeClient({...config,assets},{call:async()=>''});
 for(const asset of [0,1] as const){
  const r=client.depositRequest(asset,owner.toRawString(),5n,'cc'.repeat(32),3n);
  assert(Address.parse(r.to).equals(referenceWallet(owner,masters[asset]!,wc).address));
  assert(!Address.parse(r.to).equals(referenceWallet(owner,masters[1-asset]!,wc).address));
 }
 const other=Buffer.from(wc.hash()).fill(0).toString('hex');
 assert.throws(()=>new BridgeClient({...config,assets:[{...assets[0],walletCodeHash:other},assets[1]]},{call:async()=>''}),/invalid asset pin/);
 assert.throws(()=>new BridgeClient({...config,assets:[assets[0],{...assets[1],walletCodeHash:other}]},{call:async()=>''}),/invalid asset pin/);
});
