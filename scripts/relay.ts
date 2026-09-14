import {readFileSync,mkdirSync} from 'node:fs';
import {BridgeClient,type BridgeConfig,type ClaimAttestation} from '../src/sdk.js';
import {openMidnight} from '../src/live-midnight.js';
import {type DepositReceipt} from '../src/receipts.js';
import {type RedemptionRequest} from '../src/redemptions.js';
import {Address,toNano,internal} from '@ton/core';
import {TonClient4,WalletContractV4} from '@ton/ton';
import {keyPairFromSeed,signVerify} from '@ton/crypto';
import {releaseBody,releaseDigest} from '../src/ton.js';
import {Journal} from '../src/journal.js';
const [command,path,aPath,bPath]=process.argv.slice(2),read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
if(!path||!aPath||!bPath)throw new Error('usage: npm run relay -- claim|release CONFIG ATTESTATION_A ATTESTATION_B [--send]');
if(command==='claim'){
 const config=read(path) as BridgeConfig;config.committee=config.committee.map(p=>({x:BigInt(p.x),y:BigInt(p.y)})) as BridgeConfig['committee'];
 const entries=[read(aPath),read(bPath)] as {receipt:DepositReceipt;attestation:ClaimAttestation}[];
 const canonical=(r:DepositReceipt)=>JSON.stringify([r.id,r.network,Address.parse(r.escrow).toRawString(),r.sequence,r.asset,r.amount,r.recipient]);
 if(canonical(entries[0]!.receipt)!==canonical(entries[1]!.receipt))throw new Error('observers did not agree on the same transfer');
 for(const {attestation:a} of entries){a.signature.response=BigInt(a.signature.response);a.signature.announcement={x:BigInt(a.signature.announcement.x),y:BigInt(a.signature.announcement.y)};}
 if((process.env.MIDNIGHT_NETWORK??'local')!==config.network)throw new Error('provider network differs from bridge config');
 const client=await openMidnight();
 try{const bridge=new BridgeClient(config,{call:async(c,args)=>{const r=await client.call(config.midnightAddress,c,args);return r.public.txId;}});console.log(await bridge.claim(entries[0]!.receipt,entries.map(x=>x.attestation)));}finally{await client.close();}
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
  const pair=keyPairFromSeed(Buffer.from((read(config.walletKeyFile) as {seed:string}).seed,'hex')),wallet=WalletContractV4.create({workchain:0,publicKey:pair.publicKey});
  const client=new TonClient4({endpoint:'https://testnet-v4.tonhubapi.com'}),opened=client.open(wallet);
  mkdirSync('.state',{recursive:true,mode:0o700});const journal=new Journal('.state/ton-releases.sqlite'),key=`${escrow.toRawString()}:${r.id}`;
  try{
   if(journal.get(key))throw new Error('existing release attempt: reconcile exact wallet and jetton traces before retrying');
   const seqno=await opened.getSeqno(),tx=wallet.createTransfer({seqno,secretKey:pair.secretKey,messages:[internal({to:escrow,value:toNano('0.2'),body})]});
   journal.observe(key,JSON.stringify({request:r,wallet:wallet.address.toRawString(),seqno}));journal.move(key,'observed','prepared',tx.toBoc().toString('base64'),tx.hash().toString('hex'));journal.move(key,'prepared','sending');
   await opened.send(tx);journal.move(key,'sending','submitted');console.log('Submitted; recipient delivery is not yet confirmed. Reconcile the full jetton trace.');
  }finally{journal.close();}
 }
}else throw new Error('unknown relay command');
