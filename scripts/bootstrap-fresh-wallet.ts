import {network,statePath,readSecret} from '../src/environment.js';
import {midnightEndpoints} from '../src/midnight-endpoints.js';
import {Journal} from '../src/journal.js';
// One-time recovery for the newly generated, never-used private test wallet.
// Do not use for a wallet that has ever received shielded assets or generated DUST.
import {readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {DustLocalState,ZswapLocalState,LedgerParameters,DustStateMerkleTreeCollapsedUpdate,MerkleTreeCollapsedUpdate} from '@midnight-ntwrk/ledger-v8';
import {DustAddress} from '@midnight-ntwrk/wallet-sdk/address-format';
import WebSocket from 'ws';
import assert from 'node:assert/strict';
if(network()!=='preprod'||!process.argv.includes('--new-unused-wallet'))throw new Error('Only newly generated, unused preprod wallets may use this helper');
const endpoints=midnightEndpoints('preprod');
const fresh=readSecret<{createdAt:string}>(statePath('fresh-wallet.json'));
if(!Number.isFinite(Date.parse(fresh.createdAt))||Date.now()-Date.parse(fresh.createdAt)>21600000)throw new Error('Fresh-wallet marker expired; use full synchronization');
if(existsSync(statePath('midnight-wallet.lock'))||existsSync(statePath('midnight-deployment-candidate.json'))||existsSync(statePath('empty-bootstrap-evidence.json')))throw new Error('Wallet is active, already bootstrapped or used');
const journal=new Journal(statePath('midnight-transactions.sqlite'));try{if(journal.list().length)throw new Error('Wallet has transaction history');}finally{journal.close();}
const file=statePath('wallet-sync.json'),snapshot=JSON.parse(readFileSync(file,'utf8')),dustSnapshot=JSON.parse(snapshot.dust),shieldedSnapshot=JSON.parse(snapshot.shielded);
assert.equal(snapshot.network,'preprod');
assert.equal(Object.keys(shieldedSnapshot.coinHashes).length,0,'Wallet already has shielded history');
assert.equal(DustLocalState.deserialize(Buffer.from(dustSnapshot.state,'hex')).utxos.length,0,'Wallet already owns DUST');
const query=async(q:string)=>{const r=await fetch(endpoints.indexer,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});if(!r.ok)throw new Error(`HTTP ${r.status} for ${q.slice(0,100)}: ${(await r.text()).slice(0,100)}`);const d:any=await r.json();if(d.errors)throw new Error(JSON.stringify(d.errors));return d.data;};
const subscribe=(q:string,first=false)=>new Promise<any[]>((resolve,reject)=>{const ws=new WebSocket(endpoints.indexerWS,'graphql-transport-ws'),rows:any[]=[];const timer=setTimeout(()=>{ws.close();reject(Error('subscription timeout: '+q));},30000);const finish=()=>{clearTimeout(timer);ws.close();resolve(rows);};ws.on('open',()=>ws.send(JSON.stringify({type:'connection_init'})));ws.on('error',reject);ws.on('message',raw=>{const v=JSON.parse(raw.toString());if(v.type==='connection_ack')ws.send(JSON.stringify({id:'1',type:'subscribe',payload:{query:q}}));if(v.type==='next'){if(v.payload.errors){clearTimeout(timer);ws.close();reject(Error(JSON.stringify(v.payload.errors)));return;}rows.push(v.payload.data);if(first||v.payload.data.dustGenerations?.__typename==='DustGenerationsProgress')finish();}if(v.type==='complete')finish();if(v.type==='error'){clearTimeout(timer);ws.close();reject(Error(JSON.stringify(v.payload)));}});});
const blockQuery='{block{hash height protocolVersion zswapMerkleTreeRoot ledgerParameters zswapEndIndex dustCommitmentEndIndex dustGenerationEndIndex dustCommitmentMerkleTreeRoot dustGenerationMerkleTreeRoot}}';
const address=DustAddress.encodePublicKey('preprod',BigInt(dustSnapshot.publicKey.publicKey));
const encodeRoot=(n:bigint|undefined)=>n===undefined?undefined:'73'+Buffer.from(n.toString(16).padStart(64,'0'),'hex').reverse().toString('hex');
for(let attempt=0;attempt<10;attempt++){
 const {block:b}=await query(blockQuery);
 const [d,z,generations]=await Promise.all([subscribe('subscription{dustLedgerEvents(id:0){id maxId}}',true),subscribe('subscription{zswapLedgerEvents(id:0){id maxId}}',true),subscribe(`subscription{dustGenerations(dustAddress:"${address}",startIndex:0,endIndex:${b.dustGenerationEndIndex-1}){__typename}}`)]);
 assert(generations.length>0);assert(generations.every(row=>row.dustGenerations.__typename==='DustGenerationsProgress'),'Wallet has DUST generation history; full recovery required');
 const names=[['zswapMerkleTreeCollapsedUpdate',b.zswapEndIndex],['dustGenerationMerkleTreeUpdate',b.dustGenerationEndIndex],['dustCommitmentMerkleTreeUpdate',b.dustCommitmentEndIndex]] as const;
 const updates=await Promise.all(names.map(async([name,end])=>(await query(`{${name}(startIndex:0,endIndex:${end-1}){update startIndex endIndex}}`))[name]));
 const [dAfter,zAfter]=await Promise.all([subscribe('subscription{dustLedgerEvents(id:0){id maxId}}',true),subscribe('subscription{zswapLedgerEvents(id:0){id maxId}}',true)]);
 if(dAfter[0].dustLedgerEvents.maxId!==d[0].dustLedgerEvents.maxId||zAfter[0].zswapLedgerEvents.maxId!==z[0].zswapLedgerEvents.maxId){console.log('event tip moved; retrying');continue;}
 let zs=new ZswapLocalState();zs=zs.applyCollapsedUpdate(MerkleTreeCollapsedUpdate.deserialize(Buffer.from(updates[0].update,'hex')));
 let ds=new DustLocalState(LedgerParameters.deserialize(Buffer.from(b.ledgerParameters,'hex')).dust);ds=ds.applyGenerationCollapsedUpdate(DustStateMerkleTreeCollapsedUpdate.deserialize(Buffer.from(updates[1].update,'hex')));ds=ds.applyCommitmentCollapsedUpdate(DustStateMerkleTreeCollapsedUpdate.deserialize(Buffer.from(updates[2].update,'hex')));
 let matched:any;
 for(let i=0;i<15;i++){
  const candidate=(await query(blockQuery)).block;
  if(encodeRoot(zs.merkleTreeRoot)===candidate.zswapMerkleTreeRoot&&encodeRoot(ds.generatingTreeRoot())===candidate.dustGenerationMerkleTreeRoot&&encodeRoot(ds.commitmentTreeRoot())===candidate.dustCommitmentMerkleTreeRoot){matched=candidate;break;}
  await new Promise(r=>setTimeout(r,4000));
 }
 if(!matched){console.log('No canonical block matched all tree roots; retrying');continue;}
 Object.assign(b,matched);
 // Confirm the chosen block through the separate node RPC as well.
 const rpc:any=await (await fetch(endpoints.node,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'chain_getBlockHash',params:[b.height]})})).json();assert.equal(rpc.result,'0x'+b.hash);
 shieldedSnapshot.state=Buffer.from(zs.serialize()).toString('hex');shieldedSnapshot.offset=String(z[0].zswapLedgerEvents.maxId);dustSnapshot.state=Buffer.from(ds.serialize()).toString('hex');dustSnapshot.offset=String(d[0].dustLedgerEvents.maxId);
 snapshot.shielded=JSON.stringify(shieldedSnapshot);snapshot.dust=JSON.stringify(dustSnapshot);copyFileSync(file,file+'.before-bootstrap');writeFileSync(file,JSON.stringify(snapshot),{mode:0o600});writeFileSync(statePath('empty-bootstrap-evidence.json'),JSON.stringify({block:b.hash,height:b.height,rootChecks:3,noDustGenerations:true,dustOffset:dustSnapshot.offset,shieldedOffset:shieldedSnapshot.offset},null,2));console.log('Verified empty-wallet tree bootstrap',b.height);process.exit(0);
}
throw new Error('Could not obtain a consistent snapshot');
