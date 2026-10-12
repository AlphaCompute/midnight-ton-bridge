import {readFileSync} from 'node:fs';
import {Address,Cell} from '@ton/core';
import {TonClient4} from '@ton/ton';
import {keyPairFromSeed} from '@ton/crypto';
import {readSecret} from '../src/environment.js';
import {failureDigest,unrecordedDigest,validateAssets} from '../src/jettons.js';
import {observeFailedTransfer,observeUnrecordedCredit,type FailureTrace,type UnrecordedTrace} from '../src/ton-recovery.js';
import {authorizeSignature,type SigningPolicy} from '../src/signer-policy.js';
import {signRelease} from '../src/ton.js';
const [configPath,requestPath]=process.argv.slice(2);if(!configPath||!requestPath)throw new Error('Usage: recover:standard CONFIG REQUEST');
const c=JSON.parse(readFileSync(configPath,'utf8')) as {rpc:string;assets:unknown;escrow:string;codeHash:string;configHash:string;domain:string;committee:string[];signer:number;keyFile:string;policy:SigningPolicy};
const r=JSON.parse(readFileSync(requestPath,'utf8')) as {asset:0|1;kind?:'failed-transfer'|'unrecorded';query:string;trace:FailureTrace&UnrecordedTrace};
const assets=validateAssets(c.assets);if(r.asset!==0&&r.asset!==1)throw new Error('Invalid asset');
const client=new TonClient4({endpoint:c.rpc}),escrow=Address.parse(c.escrow);
const head=await client.getLastBlock(),account=await client.getAccount(head.last.seqno-3,escrow);
if(account.account.state.type!=='active'||!account.account.state.code||!account.account.state.data||Cell.fromBase64(account.account.state.code).hash().toString('hex')!==c.codeHash||Cell.fromBase64(account.account.state.data).beginParse().loadRef().hash().toString('hex')!==c.configHash)throw new Error('Escrow pins mismatch');
const config=Cell.fromBase64(account.account.state.data).beginParse().loadRef().beginParse();
if(config.loadBuffer(32).toString('hex')!==c.domain)throw new Error('Escrow domain mismatch');
const configuredKeys=config.loadRef().beginParse();
if(c.committee.length!==3||c.committee.some(k=>configuredKeys.loadBuffer(32).toString('hex')!==k))throw new Error('Escrow committee mismatch');
if(!config.loadAddress().equals(Address.parse(assets[r.asset].master))||config.loadRef().hash().toString('hex')!==assets[r.asset].walletCodeHash)throw new Error('Escrow token mismatch');
const key=keyPairFromSeed(Buffer.from(readSecret<{tonSeed:string}>(c.keyFile).tonSeed,'hex'));
if(!Number.isInteger(c.signer)||c.signer<0||c.signer>2||c.committee[c.signer]!==key.publicKey.toString('hex'))throw new Error('Signer does not match committee');
if(r.kind==='unrecorded'){
 // A jetton credit the escrow never recorded becomes an exact refund to its sender.
 const credit=await observeUnrecordedCredit(client,assets[r.asset],escrow,r.trace);
 const used=await client.runMethod(head.last.seqno-3,escrow,'recovered',[{type:'int',value:BigInt('0x'+credit.evidence.toString('hex'))}]);
 if(used.exitCode!==0||used.reader.readNumber()!==0)throw new Error('Credit already recovered');
 const digest=unrecordedDigest(escrow,Buffer.from(c.domain,'hex'),credit.evidence,credit.amount,credit.from);
 authorizeSignature(c.policy,`unrecorded-credit:${escrow.toRawString()}:${credit.evidence.toString('hex')}`,digest.toString('hex'),credit.amount);
 console.log(JSON.stringify({kind:'unrecorded',evidence:credit.evidence.toString('hex'),amount:credit.amount.toString(),from:credit.from.toRawString(),block:credit.block,signer:c.signer,signature:signRelease(digest,key.secretKey).toString('hex')},null,2));
}else{
 const result=await client.runMethod(head.last.seqno-3,escrow,'pending',[{type:'int',value:BigInt(r.query)}]);if(result.exitCode!==0)throw new Error('No pending instruction');
 const pending=result.reader.readCell(),p=pending.beginParse();p.loadUintBig(256);const amount=p.loadUintBig(64);
 const evidence=await observeFailedTransfer(client,assets[r.asset],escrow,BigInt(r.query),amount,r.trace);
 const digest=failureDigest(escrow,Buffer.from(c.domain,'hex'),BigInt(r.query),evidence.evidence,pending);
 authorizeSignature(c.policy,`failed-transfer:${escrow.toRawString()}:${r.query}`,digest.toString('hex'),amount);
 console.log(JSON.stringify({query:r.query,evidence:evidence.evidence.toString('hex'),block:evidence.block,signer:c.signer,signature:signRelease(digest,key.secretKey).toString('hex')},null,2));
}
