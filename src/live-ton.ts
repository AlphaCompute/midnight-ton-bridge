import {assertTonTestnet} from './ton-network.js';
import {readFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {Cell,type MessageRelaxed} from '@ton/core';
import {TonClient4,WalletContractV4} from '@ton/ton';
import {keyPairFromSeed} from '@ton/crypto';
import {readSecret,statePath,network} from './environment.js';
import {Journal} from './journal.js';
export function openTon(){
 if(network()!=='preprod')throw new Error('Live TON fixture actions require BRIDGE_NETWORK=preprod');
 const pair=keyPairFromSeed(Buffer.from(readSecret<{seed:string}>(statePath('ton-test-wallet.json')).seed,'hex'));
 const wallet=WalletContractV4.create({workchain:0,publicKey:pair.publicKey}),client=new TonClient4({endpoint:process.env.TON_RPC_URL??'https://testnet-v4.tonhubapi.com'}),opened=client.open(wallet);
 return {client,wallet,opened,send:async(id:string,messages:MessageRelaxed[])=>{
  const lock=statePath('ton-wallet.lock'),fd=openSync(lock,'wx',0o600),journal=new Journal(statePath('ton-transactions.sqlite'));
  try{
   assertTonTestnet(await client.getLastBlock());
   if(journal.get(id))throw new Error('Existing send attempt; reconcile exact transaction before retrying');
   const seqno=await opened.getSeqno(),transfer=wallet.createTransfer({seqno,secretKey:pair.secretKey,messages});
   journal.observe(id,JSON.stringify({seqno,wallet:wallet.address.toRawString()}));journal.move(id,'observed','prepared',transfer.toBoc().toString('base64'),transfer.hash().toString('hex'));journal.move(id,'prepared','sending');
   await opened.send(transfer);journal.move(id,'sending','submitted');
   const deadline=Date.now()+120000;
   while(Date.now()<deadline){if(await opened.getSeqno()>seqno)return {id,seqno,bodyHash:transfer.hash().toString('hex'),status:'wallet-sequence-advanced; verify destination trace'};await new Promise(r=>setTimeout(r,2500));}
   throw new Error('Wallet inclusion timeout; send remains ambiguous and must not be repeated');
  }finally{journal.close();closeSync(fd);unlinkSync(lock);}
 }};
}
