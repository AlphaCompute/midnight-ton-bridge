import {assertTonSendAvailable,nextAttemptId} from './ton-send-guard.js';
import {assertTonTestnet,tonClient} from './ton-network.js';
import {type MessageRelaxed} from '@ton/core';
import {WalletContractV4} from '@ton/ton';
import {keyPairFromSeed} from '@ton/crypto';
import {acquireLock,readSecret,statePath,network} from './environment.js';
import {Journal} from './journal.js';
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
   await opened.send(transfer);journal.move(attempt,'sending','submitted');
   const deadline=Date.now()+120000;
   while(Date.now()<deadline){if(await opened.getSeqno()>seqno)return {id:attempt,seqno,bodyHash,status:'wallet-sequence-advanced; verify destination trace'};await new Promise(r=>setTimeout(r,2500));}
   throw new Error('Wallet inclusion timeout; send remains ambiguous and must not be repeated');
  }finally{try{journal?.close();}finally{unlock();}}
 }};
}
