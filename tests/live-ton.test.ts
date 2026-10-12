import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {broadcastUrls,openTon,relayToTestnet} from '../src/live-ton.js';
import {TON_TESTNET_ZERO_STATE} from '../src/ton-network.js';
import {withEnv,withTempDir} from './helpers/env.js';

test('TON sender takes the wallet lock before its journal and releases it when journal initialization fails',async()=>withTempDir(dir=>
 withEnv({BRIDGE_NETWORK:'preprod',MIDNIGHT_NETWORK:'preprod',BRIDGE_STATE_DIR:dir},async()=>{
  const lock=join(dir,'ton-wallet.lock');
  writeFileSync(join(dir,'ton-test-wallet.json'),JSON.stringify({seed:'11'.repeat(32)}),{mode:0o600});
  // A directory where the journal database belongs makes initialization fail before any network access.
  mkdirSync(join(dir,'ton-transactions.sqlite'));
  const ton=openTon();
  // While another process holds the lock, the send is refused and that lock is left alone.
  writeFileSync(lock,'{"pid":0}');
  await assert.rejects(()=>ton.send('must-fail-before-network',[]),/EEXIST/);assert(existsSync(lock));
  // Without it, the send gets past the lock (creating it) and fails at the journal; the lock is then removed.
  rmSync(lock);
  await assert.rejects(()=>ton.send('must-fail-before-network',[]),/unable to open database/);
  assert.equal(existsSync(lock),false);
  await assert.rejects(()=>ton.send('must-fail-before-network',[]),/unable to open database/,'a released lock does not wedge later sends');
 })));
test('signed TON messages are relayed through toncenter as well as the reading RPC by default',()=>{
 assert.deepEqual(broadcastUrls({}),['https://testnet.toncenter.com/api/v2/sendBoc']);
 assert.deepEqual(broadcastUrls({TON_BROADCAST_URLS:' https://a/sendBoc , https://b/sendBoc '}),['https://a/sendBoc','https://b/sendBoc']);
 assert.deepEqual(broadcastUrls({TON_BROADCAST_URLS:''}),[]);
});

test('a signed message is relayed only to an endpoint that proves it serves TON testnet',async()=>{
 const calls:string[]=[];
 const endpoint=(root:string|null,sendStatus=200)=>(async(input:string|URL|Request,init?:RequestInit)=>{const url=String(input);calls.push(`${init?.method??'GET'} ${url}`);
  if(url.includes('/getMasterchainInfo'))return root===null?new Response('down',{status:503}):Response.json({ok:true,result:{init:{root_hash:root}}});
  return new Response('{}',{status:sendStatus});}) as typeof fetch;
 await relayToTestnet('https://t.example/api/v2/sendBoc?api_key=k','Ym9j',endpoint(TON_TESTNET_ZERO_STATE));
 assert.deepEqual(calls,['GET https://t.example/api/v2/getMasterchainInfo?api_key=k','POST https://t.example/api/v2/sendBoc?api_key=k']);
 for(const [root,why] of [['mainnet-zero-state','mainnet or unknown chain'],[null,'chain identity unavailable']] as const){
  calls.length=0;await assert.rejects(()=>relayToTestnet('https://m.example/api/v2/sendBoc','Ym9j',endpoint(root)),/not the pinned TON testnet/,why);
  assert(!calls.some(c=>c.startsWith('POST')),`${why}: nothing is posted`);
 }
 await assert.rejects(()=>relayToTestnet('https://t.example/api/v2/other','Ym9j',endpoint(TON_TESTNET_ZERO_STATE)),/must end in \/sendBoc/);
 await assert.rejects(()=>relayToTestnet('https://t.example/api/v2/sendBoc','Ym9j',endpoint(TON_TESTNET_ZERO_STATE,500)),/rejected the message: HTTP 500/);
});
