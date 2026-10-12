import {network} from '../src/environment.js';
import {readFileSync} from 'node:fs';
import {BridgeClient,type BridgeConfig,type ClaimAttestation} from '../src/sdk.js';
import {type DepositReceipt} from '../src/receipts.js';
import {type RedemptionRequest} from '../src/redemptions.js';
import {Address,toNano,internal} from '@ton/core';
import {signVerify} from '@ton/crypto';
import {releaseBody,releaseDigest} from '../src/ton.js';
const [command,path,aPath,bPath]=process.argv.slice(2),read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
// Buffer.toJSON runs before the replacer, so both forms are rendered as hex.
const printable=(_:string,v:unknown)=>typeof v==='bigint'?v.toString():v instanceof Uint8Array?Buffer.from(v).toString('hex'):v&&typeof v==='object'&&(v as {type?:unknown}).type==='Buffer'&&Array.isArray((v as {data?:unknown}).data)?Buffer.from((v as {data:number[]}).data).toString('hex'):v;
if(!path||!aPath||!bPath)throw new Error('usage: npm run relay -- claim|release CONFIG ATTESTATION_A ATTESTATION_B [--send]');
if(command==='claim'){
 const config=read(path) as BridgeConfig;config.committee=config.committee.map(p=>({x:BigInt(p.x),y:BigInt(p.y)})) as BridgeConfig['committee'];
 const entries=[read(aPath),read(bPath)] as {receipt:DepositReceipt;attestation:ClaimAttestation}[];
 const canonical=(r:DepositReceipt)=>JSON.stringify([r.id,r.network,Address.parse(r.escrow).toRawString(),r.sequence,r.asset,r.amount,r.recipient]);
 if(canonical(entries[0]!.receipt)!==canonical(entries[1]!.receipt))throw new Error('observers did not agree on the same transfer');
 for(const {attestation:a} of entries){a.signature.response=BigInt(a.signature.response);a.signature.announcement={x:BigInt(a.signature.announcement.x),y:BigInt(a.signature.announcement.y)};}
 if(network()!==config.network)throw new Error('provider network differs from bridge config');
 if(!process.argv.includes('--send')){
  const bridge=new BridgeClient(config,{call:async(circuit,args)=>JSON.stringify({network:config.network,address:config.midnightAddress,circuit,args},printable)});
  console.log(await bridge.claim(entries[0]!.receipt,entries.map(x=>x.attestation)));
 }else{
  // Wallet providers load heavy SDKs and open state; only --send needs them.
  const {openMidnight}=await import('../src/live-midnight.js'),client=await openMidnight();
  try{const bridge=new BridgeClient(config,{call:async(c,args)=>{const r=await client.call(config.midnightAddress,c,args);return r.public.txId;}});console.log(await bridge.claim(entries[0]!.receipt,entries.map(x=>x.attestation)));}finally{await client.close();}
 }
}else if(command==='release'){
 const config=read(path) as {network:string;domain:string;escrows:[string,string];committee:string[];walletKeyFile:string};
 if(config.network!=='ton-testnet')throw new Error('testnet only');
 const entries=([read(aPath),read(bPath)] as {request:RedemptionRequest;signer:number;signature:string}[]).sort((a,b)=>a.signer-b.signer);
 const [a,b]=entries;if(!a||!b||a.signer<0||a.signer>=b.signer||b.signer>=3||!Number.isInteger(a.signer)||!Number.isInteger(b.signer))throw new Error('invalid quorum');
 if(JSON.stringify(a.request)!==JSON.stringify(b.request))throw new Error('observers disagree');
 const r=a.request;if(r.asset!==0&&r.asset!==1)throw new Error('invalid asset');
 const escrow=Address.parse(config.escrows[r.asset]),recipient=Address.parse(r.recipient),amount=BigInt(r.amount),id=Buffer.from(r.id,'hex');
 const digest=releaseDigest(escrow,Buffer.from(config.domain,'hex'),id,amount,recipient);
 for(const e of entries)if(!signVerify(digest,Buffer.from(e.signature,'hex'),Buffer.from(config.committee[e.signer]??'','hex')))throw new Error('invalid signature');
 const body=releaseBody(id,amount,recipient,a.signer,b.signer,Buffer.from(a.signature,'hex'),Buffer.from(b.signature,'hex'));
 if(!process.argv.includes('--send')){console.log(JSON.stringify({network:'ton-testnet',to:escrow.toRawString(),value:toNano('0.2').toString(),body:body.toBoc().toString('base64')}));}
 else{
  if(network()!=='preprod')throw new Error('live releases require BRIDGE_NETWORK=preprod');
  const {openTon}=await import('../src/live-ton.js'),client=openTon(config.walletKeyFile);
  console.log(await client.send(`release:${escrow.toRawString()}:${r.id}`,[internal({to:escrow,value:toNano('0.2'),body})]));
  console.log('Submitted; reconcile the full jetton trace before asserting recipient delivery.');
 }
}else throw new Error('unknown relay command');
