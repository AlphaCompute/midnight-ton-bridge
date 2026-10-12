import {readFileSync} from 'node:fs';
import {Address,Cell,internal,toNano} from '@ton/core';
import {signVerify} from '@ton/crypto';
import {openTon} from '../src/live-ton.js';
import {assertTonTestnet} from '../src/ton-network.js';
import {failureBody,failureDigest,unrecordedBody,unrecordedDigest} from '../src/jettons.js';
const [path,aPath,bPath]=process.argv.slice(2),read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
if(!path||!aPath||!bPath)throw new Error('Usage: relay:failure CONFIG ATTESTATION_A ATTESTATION_B [--send]');
const c=read(path),entries=[read(aPath),read(bPath)].sort((a,b)=>a.signer-b.signer),[a,b]=entries;
if(!Number.isInteger(a.signer)||!Number.isInteger(b.signer)||a.signer<0||a.signer>=b.signer||b.signer>2||a.kind!==b.kind||a.query!==b.query||a.evidence!==b.evidence||a.amount!==b.amount||a.from!==b.from)throw new Error('Invalid or disagreeing quorum');
const t=openTon(c.walletKeyFile),escrow=Address.parse(c.escrow),head=await t.client.getLastBlock();assertTonTestnet(head);const state=(await t.client.getAccount(head.last.seqno-3,escrow)).account.state;
if(state.type!=='active'||!state.code||!state.data||Cell.fromBase64(state.code).hash().toString('hex')!==c.codeHash||Cell.fromBase64(state.data).beginParse().loadRef().hash().toString('hex')!==c.configHash)throw new Error('Escrow pins mismatch');
const evidence=Buffer.from(a.evidence,'hex');let digest:Buffer,body:Cell,id:string;
if(a.kind==='unrecorded'){
 const from=Address.parse(a.from),amount=BigInt(a.amount);
 digest=unrecordedDigest(escrow,Buffer.from(c.domain,'hex'),evidence,amount,from);
 for(const e of entries)if(!signVerify(digest,Buffer.from(e.signature,'hex'),Buffer.from(c.committee[e.signer],'hex')))throw new Error('Invalid signature');
 body=unrecordedBody(evidence,amount,from,a.signer,b.signer,Buffer.from(a.signature,'hex'),Buffer.from(b.signature,'hex'));id=`unrecorded:${escrow.toRawString()}:${a.evidence}`;
}else{
 const result=await t.client.runMethod(head.last.seqno-3,escrow,'pending',[{type:'int',value:BigInt(a.query)}]);if(result.exitCode!==0)throw new Error('No pending instruction');
 digest=failureDigest(escrow,Buffer.from(c.domain,'hex'),BigInt(a.query),evidence,result.reader.readCell());
 for(const e of entries)if(!signVerify(digest,Buffer.from(e.signature,'hex'),Buffer.from(c.committee[e.signer],'hex')))throw new Error('Invalid signature');
 body=failureBody(BigInt(a.query),evidence,a.signer,b.signer,Buffer.from(a.signature,'hex'),Buffer.from(b.signature,'hex'));id=`restore:${escrow.toRawString()}:${a.query}`;
}
if(!process.argv.includes('--send'))console.log(JSON.stringify({to:escrow.toRawString(),value:toNano('0.2').toString(),body:body.toBoc().toString('base64')}));
else console.log(await t.send(id,[internal({to:escrow,value:toNano('0.2'),body})]));
