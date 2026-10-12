import {authorizeSignature,type SigningPolicy} from '../src/signer-policy.js';
import {readJson,readSecret,statePath} from '../src/environment.js';
import {toJson} from '../src/encoding.js';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {Address} from '@ton/core';
import {keyPairFromSeed} from '@ton/crypto';
import {newSigningKey,verifyingKey,signClaim} from '../src/midnight.js';
import {observeTonDeposit,verifyEscrowPins,type EscrowPins} from '../src/escrow.js';
import {BridgeClient,type BridgeConfig} from '../src/sdk.js';
import {assertMidnightFinalized,openIndexer} from '../src/midnight-indexer.js';
import {midnightEndpoints} from '../src/midnight-endpoints.js';
import {verifyRedemption,type MidnightPins,type RedemptionRequest} from '../src/redemptions.js';
import {signTonDigest} from '../src/ton.js';
import {finalizedBlock,tonClient} from '../src/ton-network.js';
import {failureDigest,unrecordedDigest,validateAssets} from '../src/jettons.js';
import {observeFailedTransfer,observeUnrecordedCredit,type FailureTrace,type UnrecordedTrace} from '../src/ton-traces.js';
import type {TestNetwork} from '../src/environment.js';

// Committee member tools: generate keys and independently observe, then sign, one event.
const [command,configPath,arg]=process.argv.slice(2);
type Signer={signer:number;keyFile:string;policy:SigningPolicy};
const checkSlot=(signer:number)=>{if(!Number.isInteger(signer)||signer<0||signer>2)throw new Error('signer must be committee index 0, 1 or 2');};
/** This operator's TON key, after checking it occupies its configured committee slot. */
function tonSigner(c:Signer,committee:string[]){
 checkSlot(c.signer);const key=keyPairFromSeed(Buffer.from(readSecret<{tonSeed:string}>(c.keyFile).tonSeed,'hex'));
 if(committee[c.signer]!==key.publicKey.toString('hex'))throw new Error('signer key does not match TON committee slot');return key;
}
const usage=(text:string)=>{if(!configPath||!arg)throw new Error(`usage: npm run operator -- ${text}`);};
if(command==='keygen'){
 const dir=configPath??statePath('operator');mkdirSync(dir,{recursive:true,mode:0o700});
 const secretPath=`${dir}/secret.json`;if(existsSync(secretPath))throw new Error('operator key already exists');
 const seed=randomBytes(32),midnight=newSigningKey(),ton=keyPairFromSeed(seed);
 writeFileSync(secretPath,toJson({tonSeed:seed.toString('hex'),midnight:midnight.toString()}),{mode:0o600,flag:'wx'});
 writeFileSync(`${dir}/public.json`,toJson({ton:ton.publicKey.toString('hex'),midnight:verifyingKey(midnight)}),{mode:0o644,flag:'wx'});
 console.log(`Keys written in ${dir}; distribute public.json only.`);
}else if(command==='attest-deposit'){
 usage('attest-deposit CONFIG SEQUENCE');
 const config=readJson<Signer&{rpc:string;source:EscrowPins&{asset:0|1;confirmationDepth:number};bridge:BridgeConfig}>(configPath!);
 checkSlot(config.signer);config.bridge.committee=config.bridge.committee.map(p=>({x:BigInt(p.x),y:BigInt(p.y)})) as BridgeConfig['committee'];
 const receipt=await observeTonDeposit(tonClient({endpoint:config.rpc}),config.source,BigInt(arg!));
 const client=new BridgeClient(config.bridge,{call:async()=>{throw new Error('signer never submits');}});
 const secret=readSecret<{midnight:string}>(config.keyFile);
 const own=verifyingKey(BigInt(secret.midnight)),expected=config.bridge.committee[config.signer];
 if(!expected||own.x!==expected.x||own.y!==expected.y)throw new Error('signer key does not match committee slot');
 const digest=client.claimDigest(receipt);
 authorizeSignature(config.policy,`claim:${config.bridge.midnightAddress}:${receipt.id}`,Buffer.from(digest).toString('hex'),BigInt(receipt.amount));
 console.log(toJson({receipt,attestation:{signer:config.signer,signature:signClaim(digest,BigInt(secret.midnight))}}));
}else if(command==='attest-redemption'){
 usage('attest-redemption CONFIG REQUEST_JSON');
 const config=readJson<Signer&{network:TestNetwork;indexer:string;indexerWS:string;node?:string;tonRpc?:string;address:string;pins:MidnightPins;escrows:[EscrowPins&{master:string},EscrowPins&{master:string}];committee:string[]}>(configPath!);
 if(config.network!=='local'&&config.network!=='preprod')throw new Error('test networks only');
 const key=tonSigner(config,config.committee),provider=openIndexer(config.network,config),request=readJson<RedemptionRequest>(arg!);
 const tx=await provider.watchForTxData(request.transactionId);if(tx.status!=='SucceedEntirely')throw new Error('transaction failed');
 await assertMidnightFinalized(config.node??midnightEndpoints(config.network).node,tx.blockHeight,tx.blockHash);
 const state=await provider.queryContractState(config.address,{type:'blockHash',blockHash:tx.blockHash});if(!state)throw new Error('contract not found');
 // The release goes to escrows[asset]. Confirm on chain that each pinned escrow belongs to
 // this route and committee and holds the expected token, so a swapped config cannot pay
 // one asset for a retirement of the other.
 if(config.escrows?.length!==2)throw new Error('escrows must pin both asset escrows');
 const ton=tonClient(config.tonRpc?{endpoint:config.tonRpc}:undefined),{block}=await finalizedBlock(ton);
 for(const pin of config.escrows){
  const onChain=await verifyEscrowPins(ton,block,pin);
  if(onChain.domain!==config.pins.domain||onChain.committee.join()!==config.committee.join()||!onChain.master.equals(Address.parse(pin.master)))throw new Error(`Escrow ${pin.escrow} does not belong to this route, committee and token`);
 }
 const digest=verifyRedemption(state,config.pins,request,[config.escrows[0].escrow,config.escrows[1].escrow]);
 authorizeSignature(config.policy,`release:${config.address}:${request.id}`,digest.toString('hex'),BigInt(request.amount));
 console.log(toJson({request,blockHash:tx.blockHash,blockHeight:tx.blockHeight,signer:config.signer,signature:signTonDigest(digest,key.secretKey).toString('hex')}));
}else if(command==='attest-recovery'){
 // A downstream-failed transfer (restore its exact pending instruction) or a jetton credit
 // the escrow never recorded (refund it to its sender). See docs/operations.md#recovery.
 usage('attest-recovery CONFIG REQUEST_JSON');
 const c=readJson<Signer&EscrowPins&{rpc:string;assets:unknown;domain:string;committee:string[]}>(configPath!);
 const r=readJson<{asset:0|1;kind?:'failed-transfer'|'unrecorded';query:string;trace:FailureTrace&UnrecordedTrace}>(arg!);
 const assets=validateAssets(c.assets);if(r.asset!==0&&r.asset!==1)throw new Error('Invalid asset');
 const client=tonClient({endpoint:c.rpc}),escrow=Address.parse(c.escrow),{block}=await finalizedBlock(client);
 const onChain=await verifyEscrowPins(client,block,c);
 if(onChain.domain!==c.domain)throw new Error('Escrow domain mismatch');
 if(c.committee.length!==3||c.committee.some((k,i)=>onChain.committee[i]!==k))throw new Error('Escrow committee mismatch');
 if(!onChain.master.equals(Address.parse(assets[r.asset].master))||onChain.walletCodeHash!==assets[r.asset].walletCodeHash)throw new Error('Escrow token mismatch');
 const key=tonSigner(c,c.committee);
 if(r.kind==='unrecorded'){
  const credit=await observeUnrecordedCredit(client,assets[r.asset],escrow,r.trace);
  const used=await client.runMethod(block,escrow,'recovered',[{type:'int',value:BigInt('0x'+credit.evidence.toString('hex'))}]);
  if(used.exitCode!==0||used.reader.readNumber()!==0)throw new Error('Credit already recovered');
  const digest=unrecordedDigest(escrow,Buffer.from(c.domain,'hex'),credit.evidence,credit.amount,credit.from);
  authorizeSignature(c.policy,`unrecorded-credit:${escrow.toRawString()}:${credit.evidence.toString('hex')}`,digest.toString('hex'),credit.amount);
  console.log(toJson({kind:'unrecorded',evidence:credit.evidence.toString('hex'),amount:credit.amount.toString(),from:credit.from.toRawString(),block:credit.block,signer:c.signer,signature:signTonDigest(digest,key.secretKey).toString('hex')}));
 }else{
  const result=await client.runMethod(block,escrow,'pending',[{type:'int',value:BigInt(r.query)}]);if(result.exitCode!==0)throw new Error('No pending instruction');
  const pending=result.reader.readCell(),p=pending.beginParse();p.loadUintBig(256);const amount=p.loadCoins();
  const evidence=await observeFailedTransfer(client,assets[r.asset],escrow,BigInt(r.query),amount,r.trace);
  const digest=failureDigest(escrow,Buffer.from(c.domain,'hex'),BigInt(r.query),evidence.evidence,pending);
  authorizeSignature(c.policy,`failed-transfer:${escrow.toRawString()}:${r.query}`,digest.toString('hex'),amount);
  console.log(toJson({query:r.query,evidence:evidence.evidence.toString('hex'),block:evidence.block,signer:c.signer,signature:signTonDigest(digest,key.secretKey).toString('hex')}));
 }
}else throw new Error('Commands: keygen [directory], attest-deposit CONFIG SEQUENCE, attest-redemption CONFIG REQUEST_JSON, attest-recovery CONFIG REQUEST_JSON');
