import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,realpathSync,statSync,writeFileSync,chmodSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {network,stateDirectory,statePath,readSecret,readState,routeDomain,acquireLock,writeFileAtomic} from '../src/environment.js';
import {assertTonTestnet,finalizedBlock,TON_TESTNET_ZERO_STATE} from '../src/ton-network.js';
import {withEnv,withTempDir} from './helpers/env.js';

test('network selection is isolated: conflicting or unknown settings fail closed',async()=>{
 await withEnv({BRIDGE_NETWORK:undefined,MIDNIGHT_NETWORK:undefined},()=>assert.equal(network(),'local'));
 await withEnv({BRIDGE_NETWORK:'preprod',MIDNIGHT_NETWORK:undefined},()=>assert.equal(network(),'preprod'));
 await withEnv({BRIDGE_NETWORK:undefined,MIDNIGHT_NETWORK:'preprod'},()=>assert.equal(network(),'preprod'));
 await withEnv({BRIDGE_NETWORK:'preprod',MIDNIGHT_NETWORK:'local'},()=>assert.throws(network,/conflicting/));
 await withEnv({BRIDGE_NETWORK:'wrong',MIDNIGHT_NETWORK:undefined},()=>assert.throws(network,/unknown/));
});

test('state directory is per network, owner-only, overridable, and state file names are validated',async()=>withTempDir(async dir=>{
 // Default location is relative to the working directory, so run it inside the temp dir, never the repo.
 const cwd=process.cwd();
 try{
  process.chdir(dir);
  await withEnv({BRIDGE_NETWORK:'preprod',MIDNIGHT_NETWORK:undefined,BRIDGE_STATE_DIR:undefined},()=>{
   const state=stateDirectory();assert.equal(state,join(realpathSync(dir),'.state','preprod'));assert.equal(statSync(state).mode&0o777,0o700);
  });
 }finally{process.chdir(cwd);}
 const custom=join(dir,'custom');
 await withEnv({BRIDGE_NETWORK:'preprod',MIDNIGHT_NETWORK:undefined,BRIDGE_STATE_DIR:custom},()=>{
  assert.equal(stateDirectory(),custom);assert.equal(statePath('a.json'),join(custom,'a.json'));
  for(const bad of ['','a/b','..'])assert.throws(()=>statePath(bad),/invalid state file/);
  writeFileSync(join(custom,'a.json'),'{"n":1}');assert.deepEqual(readState('a.json'),{n:1});
 });
}));

test('secrets must be owner-only regular files; route domain must be 32-byte hex',async()=>withTempDir(dir=>{
 const key=join(dir,'key.json');writeFileSync(key,'{"seed":"test"}',{mode:0o600});
 assert.equal(readSecret<{seed:string}>(key).seed,'test');
 chmodSync(key,0o644);assert.throws(()=>readSecret(key),/owner-only/);
 assert.throws(()=>readSecret(dir),/owner-only/);
 assert.deepEqual(routeDomain('ab'.repeat(32)),Buffer.alloc(32,0xab));
 for(const bad of [undefined,'ab'.repeat(31),'zz'.repeat(32)])assert.throws(()=>routeDomain(bad),/BRIDGE_DOMAIN/);
}));

test('lock files are exclusive and idempotently released; atomic writes are owner-only',async()=>withTempDir(dir=>{
 const lock=join(dir,'x.lock'),release=acquireLock(lock,{purpose:'test'});
 assert.equal(JSON.parse(readFileSync(lock,'utf8')).purpose,'test');assert.equal(statSync(lock).mode&0o777,0o600);
 assert.throws(()=>acquireLock(lock),/EEXIST/);
 release();assert(!existsSync(lock));release();
 acquireLock(lock)();
 const file=join(dir,'f.json');writeFileAtomic(file,'one');writeFileAtomic(file,'two');
 assert.equal(readFileSync(file,'utf8'),'two');assert.equal(statSync(file).mode&0o777,0o600);assert(!existsSync(file+'.tmp'));
}));

test('TON network pin: only the testnet zero state with a fresh, deep enough head is accepted',async()=>{
 assert.doesNotThrow(()=>assertTonTestnet({init:{rootHash:TON_TESTNET_ZERO_STATE}}));
 assert.throws(()=>assertTonTestnet({init:{rootHash:'wrong-chain'}}),/not the pinned/);
 const head=(over:{rootHash?:string;now?:number;seqno?:number}={})=>({getLastBlock:async()=>({last:{seqno:over.seqno??20},init:{rootHash:over.rootHash??TON_TESTNET_ZERO_STATE},now:over.now??Date.now()/1000})}) as unknown as Parameters<typeof finalizedBlock>[0];
 assert.equal((await finalizedBlock(head(),3)).block,17);
 await assert.rejects(()=>finalizedBlock(head({rootHash:'mainnet'})),/not the pinned/);
 await assert.rejects(()=>finalizedBlock(head({now:Date.now()/1000-600})),/stale/);
 await assert.rejects(()=>finalizedBlock(head({seqno:3}),3),/not ready/);
 await assert.rejects(()=>finalizedBlock(head(),0),/confirmation depth/);
});
