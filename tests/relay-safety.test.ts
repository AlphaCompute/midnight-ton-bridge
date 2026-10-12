import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
import {assertTonSendAvailable} from '../src/ton-send-guard.js';import type {Entry} from '../src/journal.js';
import {BridgeClient,type BridgeConfig} from '../src/sdk.js';import {verifyingKey,signClaim} from '../src/midnight.js';import type {DepositReceipt} from '../src/receipts.js';
const wallet='0:'+'11'.repeat(32),other='0:'+'22'.repeat(32);
test('new TON logical IDs cannot bypass ambiguous sends or reuse reserved sequences',()=>{
 const row=(stage:Entry['stage'],seqno=4):Entry=>({id:'prior',stage,payload:JSON.stringify({wallet,seqno}),transaction:'bytes',txid:'hash',error:null});
 for(const stage of ['prepared','sending'] as const)for(const next of [4,5])assert.throws(()=>assertTonSendAvailable([row(stage)],wallet,next),/Unresolved/);
 assert.throws(()=>assertTonSendAvailable([row('submitted')],wallet,4),/Unresolved/);
 assert.doesNotThrow(()=>assertTonSendAvailable([row('submitted')],wallet,5));
 assert.doesNotThrow(()=>assertTonSendAvailable([row('confirmed')],wallet,5));
 assert.doesNotThrow(()=>assertTonSendAvailable([row('sending')],other,4));
 assert.throws(()=>assertTonSendAvailable([{...row('sending'),payload:'bad'}],wallet,5));
 assert.throws(()=>assertTonSendAvailable([row('submitted',-1)],wallet,5),/Invalid/);
});
test('claim relay defaults to verified preparation without wallet state or network access',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bridge-relay-'));try{
  const config:BridgeConfig={network:'preprod',domain:'33'.repeat(32),midnightAddress:'44'.repeat(32),escrows:[wallet,other],committee:[verifyingKey(11n),verifyingKey(22n),verifyingKey(33n)]};
  const receipt:DepositReceipt={id:'55'.repeat(32),network:'ton-testnet',escrow:wallet,sequence:'0',asset:0,amount:'1',recipient:'66'.repeat(32),block:10,blockRoot:'test'};
  const client=new BridgeClient(config,{call:async()=>{throw Error('must not submit');}}),digest=client.claimDigest(receipt);
  const save=(n:string,v:unknown)=>{const p=join(dir,n);writeFileSync(p,JSON.stringify(v,(_,v)=>typeof v==='bigint'?v.toString():v));return p;};
  const configFile=save('config.json',config),a=save('a.json',{receipt,attestation:{signer:0,signature:signClaim(digest,11n)}}),b=save('b.json',{receipt,attestation:{signer:2,signature:signClaim(digest,33n)}});
  const result=spawnSync(process.execPath,['--import','tsx',resolve('scripts/relay.ts'),'claim',configFile,a,b],{encoding:'utf8',timeout:30000,env:{...process.env,BRIDGE_NETWORK:'preprod',MIDNIGHT_NETWORK:'preprod',BRIDGE_STATE_DIR:join(dir,'must-not-create'),MIDNIGHT_SEED_FILE:join(dir,'missing-secret'),MIDNIGHT_INDEXER_URL:'http://127.0.0.1:1'}});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).circuit,'claim');assert.deepEqual(readdirSync(dir).sort(),['a.json','b.json','config.json']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('TON sender releases its process lock when journal initialization fails',async()=>{
 const {mkdirSync,existsSync}=await import('node:fs');const {openTon}=await import('../src/live-ton.js');
 const dir=mkdtempSync(join(tmpdir(),'bridge-send-lock-'));const saved={BRIDGE_NETWORK:process.env.BRIDGE_NETWORK,MIDNIGHT_NETWORK:process.env.MIDNIGHT_NETWORK,BRIDGE_STATE_DIR:process.env.BRIDGE_STATE_DIR};
 try{
  process.env.BRIDGE_NETWORK='preprod';process.env.MIDNIGHT_NETWORK='preprod';process.env.BRIDGE_STATE_DIR=dir;
  writeFileSync(join(dir,'ton-test-wallet.json'),JSON.stringify({seed:'11'.repeat(32)}),{mode:0o600});mkdirSync(join(dir,'ton-transactions.sqlite'));
  await assert.rejects(()=>openTon().send('must-fail-before-network',[]));assert.equal(existsSync(join(dir,'ton-wallet.lock')),false);
 }finally{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;rmSync(dir,{recursive:true,force:true});}
});

test('only a provably expired, unconsumed wallet message may be marked rejected',async()=>{
 const {walletMessageExpired,WALLET_EXPIRY_MARGIN}=await import('../src/ton-send-guard.js');const {WalletContractV4}=await import('@ton/ton');const {keyPairFromSeed}=await import('@ton/crypto');
 const pair=keyPairFromSeed(Buffer.alloc(32,7)),w=WalletContractV4.create({workchain:0,publicKey:pair.publicKey}),validUntil=1_800_000_000;
 const boc=w.createTransfer({seqno:5,secretKey:pair.secretKey,messages:[],timeout:validUntil}).toBoc().toString('base64');
 assert.equal(walletMessageExpired(boc,5,5,validUntil+WALLET_EXPIRY_MARGIN+1),true);
 assert.equal(walletMessageExpired(boc,5,5,validUntil+WALLET_EXPIRY_MARGIN),false,'clock-skew margin required');
 assert.equal(walletMessageExpired(boc,5,6,validUntil+3600),false,'consumed sequence may be this message');
 assert.equal(walletMessageExpired(boc,5,4,validUntil+3600),false);
 assert.throws(()=>walletMessageExpired(boc,4,4,validUntil+3600),/does not match/);
});
test('a logical TON send may be retried only after every earlier attempt is a proven rejection',async()=>{
 const {nextAttemptId}=await import('../src/ton-send-guard.js');
 const rows=new Map<string,Entry>(),get=(id:string)=>rows.get(id),put=(id:string,stage:Entry['stage'])=>rows.set(id,{id,stage,payload:'{}',transaction:null,txid:null,error:null});
 assert.equal(nextAttemptId(get,'release:x'),'release:x');
 for(const stage of ['observed','prepared','sending','submitted','confirmed'] as const){put('release:x',stage);assert.throws(()=>nextAttemptId(get,'release:x'),/reconcile/);}
 put('release:x','rejected');assert.equal(nextAttemptId(get,'release:x'),'release:x#2');
 put('release:x#2','sending');assert.throws(()=>nextAttemptId(get,'release:x'),/reconcile/);
 put('release:x#2','rejected');assert.equal(nextAttemptId(get,'release:x'),'release:x#3');
});
test('signed TON messages are relayed through toncenter as well as the reading RPC by default',async()=>{
 const {broadcastUrls}=await import('../src/live-ton.js');
 assert.deepEqual(broadcastUrls({}),['https://testnet.toncenter.com/api/v2/sendBoc']);
 assert.deepEqual(broadcastUrls({TON_BROADCAST_URLS:' https://a/sendBoc , https://b/sendBoc '}),['https://a/sendBoc','https://b/sendBoc']);
 assert.deepEqual(broadcastUrls({TON_BROADCAST_URLS:''}),[]);
});
