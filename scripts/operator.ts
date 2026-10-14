import {authorizeSignature} from '../src/signer-policy.js';
import {attestDeposit,attestRedemption,tonSigner,type DepositSignerConfig,type RedemptionSignerConfig,type Signer} from '../src/attest.js';
import {readJson,statePath} from '../src/environment.js';
import {toJson} from '../src/encoding.js';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {Address} from '@ton/core';
import {keyPairFromSeed} from '@ton/crypto';
import {newSigningKey,verifyingKey} from '../src/midnight.js';
import {verifyEscrowPins,type EscrowPins} from '../src/escrow.js';
import {assertMidnightFinalized,MIDNIGHT_PREPROD_GENESIS,openIndexer} from '../src/midnight-indexer.js';
import {midnightEndpoints} from '../src/midnight-endpoints.js';
import type {RedemptionRequest} from '../src/redemptions.js';
import {signTonDigest} from '../src/ton.js';
import {finalizedBlock,tonClient} from '../src/ton-network.js';
import {failureDigest,unrecordedDigest,validateAssets} from '../src/jettons.js';
import {observeFailedTransfer,observeUnrecordedCredit,type FailureTrace,type UnrecordedTrace} from '../src/ton-traces.js';

// Committee member tools: generate keys and independently observe, then sign, one event.
const [command,configPath,arg]=process.argv.slice(2);
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
 const config=readJson<DepositSignerConfig>(configPath!);
 console.log(toJson(await attestDeposit(config,tonClient({endpoint:config.rpc}),BigInt(arg!))));
}else if(command==='attest-redemption'){
 usage('attest-redemption CONFIG REQUEST_JSON');
 const config=readJson<RedemptionSignerConfig>(configPath!);
 if(config.network!=='local'&&config.network!=='preprod')throw new Error('test networks only');
 const provider=openIndexer(config.network,config.indexer&&config.indexerWS?{indexer:config.indexer,indexerWS:config.indexerWS}:undefined),node=config.node??midnightEndpoints(config.network).node;
 console.log(toJson(await attestRedemption(config,{
  ton:tonClient(config.tonRpc?{endpoint:config.tonRpc}:undefined),
  transaction:id=>provider.watchForTxData(id),
  assertFinalized:(height,hash)=>assertMidnightFinalized(node,height,hash,config.network==='preprod'?{genesis:MIDNIGHT_PREPROD_GENESIS}:{}),
  stateAt:blockHash=>provider.queryContractState(config.address,{type:'blockHash',blockHash})},readJson<RedemptionRequest>(arg!))));
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
  authorizeSignature(c.policy,`failed-transfer:${escrow.toRawString()}:${BigInt(r.query)}`,digest.toString('hex'),amount);
  console.log(toJson({query:r.query,evidence:evidence.evidence.toString('hex'),block:evidence.block,signer:c.signer,signature:signTonDigest(digest,key.secretKey).toString('hex')}));
 }
}else throw new Error('Commands: keygen [directory], attest-deposit CONFIG SEQUENCE, attest-redemption CONFIG REQUEST_JSON, attest-recovery CONFIG REQUEST_JSON');
