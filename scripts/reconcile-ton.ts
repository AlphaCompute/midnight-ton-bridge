import {Address} from '@ton/core';
import {TonClient4} from '@ton/ton';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {network,statePath} from '../src/environment.js';
import {assertTonTestnet} from '../src/ton-network.js';
import {Journal} from '../src/journal.js';
if(network()!=='preprod')throw new Error('TON testnet only');
const id=process.argv[2];if(!id)throw new Error('usage: npm run reconcile:ton -- ID|all');
const j=new Journal(statePath('ton-transactions.sqlite')),client=new TonClient4({endpoint:process.env.TON_RPC_URL??'https://testnet-v4.tonhubapi.com'});
try{
 const rows=j.list().filter(r=>(id==='all'||r.id===id)&&(r.stage==='submitted'||r.stage==='sending'));
 if(!rows.length)throw new Error('No matching unresolved transaction');
 const head=await client.getLastBlock();assertTonTestnet(head);const block=head.last.seqno-3;
 for(const row of rows){
  const payload=JSON.parse(row.payload),wallet=Address.parse(payload.wallet);let last=(await client.getAccountLite(block,wallet)).account.last,found=false;
  for(let page=0;last&&page<64;page++){
   const txs=await client.getAccountTransactions(wallet,BigInt(last.lt),Buffer.from(last.hash,'base64'));if(!txs.length)break;
   const match=txs.find(r=>r.tx.inMessage?.info.type==='external-in'&&r.tx.inMessage.body.hash().toString('hex')===row.txid);
   if(match){
    const d=match.tx.description;const success=d.type==='generic'&&!d.aborted&&d.computePhase.type==='vm'&&d.computePhase.success&&(!d.actionPhase||d.actionPhase.success);
    const file=statePath(`ton-inclusion-${createHash('sha256').update(row.id).digest('hex')}.json`);
    writeFileSync(file,JSON.stringify({id:row.id,wallet:wallet.toRawString(),bodyHash:row.txid,transactionHash:match.tx.hash().toString('hex'),block:match.block,status:success?'wallet transaction executed':'wallet transaction rejected',recipientDelivery:'Verify separately using the jetton trace'},null,2));
    j.move(row.id,row.stage,success?'confirmed':'rejected');console.log(row.id,success?'wallet inclusion confirmed':'rejected');found=true;break;
   }
   const oldest=txs.reduce((a,b)=>a.tx.lt<b.tx.lt?a:b).tx;if(oldest.prevTransactionLt===0n)break;
   last={lt:oldest.prevTransactionLt.toString(),hash:Buffer.from(oldest.prevTransactionHash.toString(16).padStart(64,'0'),'hex').toString('base64')};
  }
  if(!found)throw new Error(`Exact transaction ${row.id} not found in scanned history; remains unresolved`);
 }
}finally{j.close();}
