import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {verifyingKey} from '../src/midnight.js';
import {keyPairFromSeed} from '@ton/crypto';
import {withTempDir} from './helpers/env.js';

/** Runs a CLI script offline: unreachable endpoints and a private state directory. */
const cli=(dir:string,script:string,args:string[],env:Record<string,string>={})=>spawnSync(process.execPath,['--import','tsx',resolve('scripts',script),...args],{encoding:'utf8',timeout:120000,
 env:{...process.env,BRIDGE_NETWORK:'local',MIDNIGHT_NETWORK:'local',BRIDGE_STATE_DIR:join(dir,'state'),TON_RPC_URL:'http://127.0.0.1:1',MIDNIGHT_INDEXER_URL:'http://127.0.0.1:1',...env}});
const save=(dir:string,n:string,v:unknown)=>{const p=join(dir,n);writeFileSync(p,JSON.stringify(v));return p;};

test('operator keygen writes an owner-only secret and a matching public file, once',()=>withTempDir(dir=>{
 const keys=join(dir,'keys'),first=cli(dir,'operator.ts',['keygen',keys]);
 assert.equal(first.status,0,first.stderr);
 assert.equal(statSync(join(keys,'secret.json')).mode&0o777,0o600);assert.equal(statSync(keys).mode&0o777,0o700);
 const secret=JSON.parse(readFileSync(join(keys,'secret.json'),'utf8')),pub=JSON.parse(readFileSync(join(keys,'public.json'),'utf8'));
 assert.equal(pub.ton,keyPairFromSeed(Buffer.from(secret.tonSeed,'hex')).publicKey.toString('hex'));
 const point=verifyingKey(BigInt(secret.midnight));assert.deepEqual(pub.midnight,{x:point.x.toString(),y:point.y.toString()});
 assert.doesNotMatch(readFileSync(join(keys,'public.json'),'utf8'),new RegExp(secret.tonSeed));
 // A second keygen never replaces an existing identity.
 const again=cli(dir,'operator.ts',['keygen',keys]);assert.notEqual(again.status,0);assert.match(again.stderr,/already exists/);
 assert.deepEqual(readdirSync(keys).sort(),['public.json','secret.json']);
}));

test('operator commands refuse incomplete input before any network access',()=>withTempDir(dir=>{
 const usage=cli(dir,'operator.ts',['attest-deposit']);assert.notEqual(usage.status,0);assert.match(usage.stderr,/usage: npm run operator -- attest-deposit/);
 const unknown=cli(dir,'operator.ts',['sign-anything']);assert.notEqual(unknown.status,0);assert.match(unknown.stderr,/Commands: keygen/);
 const mainnet=save(dir,'r.json',{network:'mainnet'});
 const refused=cli(dir,'operator.ts',['attest-redemption',mainnet,save(dir,'q.json',{})]);assert.notEqual(refused.status,0);assert.match(refused.stderr,/test networks only/);
}));

test('recovery relay refuses disagreeing attestations before reading the chain',()=>withTempDir(dir=>{
 const config=save(dir,'c.json',{escrow:'0:'+'11'.repeat(32),codeHash:'00'.repeat(32),configHash:'00'.repeat(32),domain:'22'.repeat(32),committee:[]});
 const a=save(dir,'a.json',{kind:'unrecorded',evidence:'33'.repeat(32),amount:'5',from:'0:'+'44'.repeat(32),signer:0,signature:'00'});
 const b=save(dir,'b.json',{kind:'unrecorded',evidence:'33'.repeat(32),amount:'6',from:'0:'+'44'.repeat(32),signer:2,signature:'00'});
 const result=cli(dir,'relay.ts',['recovery',config,a,b]);assert.notEqual(result.status,0);assert.match(result.stderr,/disagreeing quorum/);
 const unknown=cli(dir,'relay.ts',['mint',config,a,b]);assert.notEqual(unknown.status,0);assert.match(unknown.stderr,/unknown relay command/);
}));

test('route check runs only against preprod',()=>withTempDir(dir=>{
 const result=cli(dir,'check-route.ts',[]);assert.notEqual(result.status,0);assert.match(result.stderr,/preprod required/);
}));

test('watch queues well-formed redemption requests and refuses unsafe relayer configs',()=>withTempDir(dir=>{
 const mailbox=join(dir,'mailbox'),request={id:'ab'.repeat(32),asset:1,amount:'25',recipient:'0:'+'12'.repeat(32),transactionId:'tx'};
 const queued=cli(dir,'watch.ts',['request',mailbox,save(dir,'req.json',request)]);assert.equal(queued.status,0,queued.stderr);
 assert.deepEqual(JSON.parse(readFileSync(join(mailbox,'requests',`${request.id}.json`),'utf8')),request);
 const bad=cli(dir,'watch.ts',['request',mailbox,save(dir,'bad.json',{...request,id:'../x'})]);assert.notEqual(bad.status,0);assert.match(bad.stderr,/32-byte hex/);
 // The relayer refuses a bridge config for another network than the one it would transact on.
 const bridge={network:'preprod',domain:'33'.repeat(32),midnightAddress:'44'.repeat(32),escrows:['0:'+'11'.repeat(32),'0:'+'22'.repeat(32)],committee:[]};
 const wrong=cli(dir,'watch.ts',['relayer',save(dir,'relayer.json',{mailbox,bridge}),'--once']);assert.notEqual(wrong.status,0);assert.match(wrong.stderr,/must match/);
 const tonLocal=cli(dir,'watch.ts',['relayer',save(dir,'relayer2.json',{mailbox,bridge:{...bridge,network:'local'},ton:{network:'ton-testnet'}}),'--once']);
 assert.notEqual(tonLocal.status,0);assert.match(tonLocal.stderr,/BRIDGE_NETWORK=preprod/);
 const usage=cli(dir,'watch.ts',['relay']);assert.notEqual(usage.status,0);assert.match(usage.stderr,/usage: npm run watch/);
}));
