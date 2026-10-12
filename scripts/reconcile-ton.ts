import {Address} from '@ton/core';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {network,statePath} from '../src/environment.js';
import {assertTonTestnet,tonClient,TON_FINALITY_DEPTH} from '../src/ton-network.js';
import {txSucceeded} from '../src/ton-traces.js';
import {Journal} from '../src/journal.js';
import {walletMessageExpired} from '../src/ton-send-guard.js';
if(network()!=='preprod')throw new Error('TON testnet only');
const id=process.argv[2];if(!id)throw new Error('usage: npm run reconcile:ton -- ID|all');
const j=new Journal(statePath('ton-transactions.sqlite')),client=tonClient();
try{
 const matching=j.pending().filter(r=>id==='all'||r.id===id);
 if(!matching.length)throw new Error('No matching unresolved transaction');
 // openTon broadcasts only after entering `sending`, so a `prepared` entry was never sent.
 for(const row of matching.filter(r=>r.stage==='prepared')){j.move(row.id,'prepared','rejected',{error:'never broadcast'});console.log(row.id,'never broadcast; safe to prepare a new send');}
 const rows=matching.filter(r=>r.stage!=='prepared');
 const head=await client.getLastBlock();assertTonTestnet(head);const block=head.last.seqno-TON_FINALITY_DEPTH,unresolved:string[]=[];
 for(const row of rows){
  const payload=JSON.parse(row.payload),wallet=Address.parse(payload.wallet);let last=(await client.getAccountLite(block,wallet)).account.last,found=false;
  for(let page=0;last&&page<64;page++){
   const txs=await client.getAccountTransactions(wallet,BigInt(last.lt),Buffer.from(last.hash,'base64'));if(!txs.length)break;
   const match=txs.find(r=>r.tx.inMessage?.info.type==='external-in'&&r.tx.inMessage.body.hash().toString('hex')===row.txid);
   if(match){
    const success=txSucceeded(match.tx);
    const file=statePath(`ton-inclusion-${createHash('sha256').update(row.id).digest('hex')}.json`);
    writeFileSync(file,JSON.stringify({id:row.id,wallet:wallet.toRawString(),bodyHash:row.txid,transactionHash:match.tx.hash().toString('hex'),block:match.block,status:success?'wallet transaction executed':'wallet transaction rejected',recipientDelivery:'Verify separately using the jetton trace'},null,2));
    j.move(row.id,row.stage,success?'confirmed':'rejected');console.log(row.id,success?'wallet inclusion confirmed':'rejected');found=true;break;
   }
   const oldest=txs.reduce((a,b)=>a.tx.lt<b.tx.lt?a:b).tx;if(oldest.prevTransactionLt===0n)break;
   last={lt:oldest.prevTransactionLt.toString(),hash:Buffer.from(oldest.prevTransactionHash.toString(16).padStart(64,'0'),'hex').toString('base64')};
  }
  if(found)continue;
  // Absence alone is not rejection. Only a provably expired, unconsumed sequence is.
  const seqno=await client.runMethod(head.last.seqno,wallet,'seqno');
  if(seqno.exitCode===0&&walletMessageExpired(row.transaction!,payload.seqno,Number(seqno.reader.readBigNumber()),head.now)){
   j.move(row.id,row.stage,'rejected',{error:'expired: wallet sequence unconsumed after valid_until'});console.log(row.id,'expired without execution; safe to prepare a new send');
  }else unresolved.push(row.id);
 }
 if(unresolved.length)throw new Error(`Exact transaction(s) ${unresolved.join(', ')} not found in scanned history and not provably expired; remain unresolved`);
}finally{j.close();}
