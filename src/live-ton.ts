import {assertTonSendAvailable,nextAttemptId} from './ton-send-guard.js';
import {assertTonTestnet,tonClient} from './ton-network.js';
import {beginCell,external,storeMessage,type MessageRelaxed} from '@ton/core';
import {WalletContractV4} from '@ton/ton';
import {keyPairFromSeed} from '@ton/crypto';
import {acquireLock,readSecret,statePath,network} from './environment.js';
import {Journal} from './journal.js';
/** Extra endpoints that receive the same signed message (toncenter `sendBoc` shape).
 * Relaying identical bytes everywhere is safe: the wallet sequence admits it once. */
export function broadcastUrls(env:NodeJS.ProcessEnv=process.env){
 return (env.TON_BROADCAST_URLS??'https://testnet.toncenter.com/api/v2/sendBoc').split(',').map(u=>u.trim()).filter(Boolean);
}
/** Funded TON testnet wallet whose sends are serialized by a lock and journaled before broadcast. */
export function openTon(keyFile=statePath('ton-test-wallet.json')){
 // BRIDGE_NETWORK=preprod pairs Midnight preprod with TON testnet.
 if(network()!=='preprod')throw new Error('Live TON actions require BRIDGE_NETWORK=preprod');
 const pair=keyPairFromSeed(Buffer.from(readSecret<{seed:string}>(keyFile).seed,'hex'));
 const wallet=WalletContractV4.create({workchain:0,publicKey:pair.publicKey}),client=tonClient(),opened=client.open(wallet);
 return {client,wallet,opened,send:async(id:string,messages:MessageRelaxed[])=>{
  const unlock=acquireLock(statePath('ton-wallet.lock'));let journal:Journal|undefined;
  try{
   journal=new Journal(statePath('ton-transactions.sqlite'));
   assertTonTestnet(await client.getLastBlock());
   const attempt=nextAttemptId(key=>journal!.get(key),id);
   const seqno=await opened.getSeqno();
   assertTonSendAvailable(journal.list(),wallet.address.toRawString(),seqno);
   const transfer=wallet.createTransfer({seqno,secretKey:pair.secretKey,messages}),bodyHash=transfer.hash().toString('hex');
   journal.observe(attempt,JSON.stringify({seqno,wallet:wallet.address.toRawString()}));journal.move(attempt,'observed','prepared',{tx:transfer.toBoc().toString('base64'),txid:bodyHash});journal.move(attempt,'prepared','sending');
   // A single RPC can serve reads while silently dropping sends; relay through every
   // configured endpoint and treat any acceptance as a submission.
   const boc=beginCell().store(storeMessage(external({to:wallet.address,body:transfer}))).endCell().toBoc().toString('base64');
   const relays=await Promise.allSettled([opened.send(transfer),...broadcastUrls().map(async url=>{
    const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({boc}),signal:AbortSignal.timeout(20000)});
    if(!res.ok)throw new Error(`${new URL(url).host} rejected the message: HTTP ${res.status}`);})]);
   if(!relays.some(x=>x.status==='fulfilled'))throw new Error('No endpoint accepted the signed message; it remains ambiguous until reconciled');
   journal.move(attempt,'sending','submitted');
   const deadline=Date.now()+120000;
   while(Date.now()<deadline){if(await opened.getSeqno()>seqno)return {id:attempt,seqno,bodyHash,status:'wallet-sequence-advanced; verify destination trace'};await new Promise(r=>setTimeout(r,2500));}
   throw new Error('Wallet inclusion timeout; send remains ambiguous and must not be repeated');
  }finally{try{journal?.close();}finally{unlock();}}
 }};
}
