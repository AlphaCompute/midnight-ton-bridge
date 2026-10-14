import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Address,Cell,toNano} from '@ton/core';
import {BridgeClient,type BridgeConfig} from '../src/sdk.js';
import {signClaim} from '../src/midnight.js';
import type {DepositReceipt} from '../src/escrow.js';
import {releaseBody,releaseDigest} from '../src/ton.js';
import {toJson} from '../src/encoding.js';
import {MIDNIGHT_SECRETS,midnightCommittee} from './helpers/midnight.js';
import {TON_COMMITTEE,quorumSign} from './helpers/ton.js';
import {withTempDir} from './helpers/env.js';

const wallet='0:'+'11'.repeat(32),other='0:'+'22'.repeat(32);
/** Runs the relay CLI with no wallet, no state directory and an unreachable indexer. */
const relay=(dir:string,args:string[])=>spawnSync(process.execPath,['--import','tsx',resolve('scripts/relay.ts'),...args],{encoding:'utf8',timeout:120000,
 env:{...process.env,BRIDGE_NETWORK:'preprod',MIDNIGHT_NETWORK:'preprod',BRIDGE_STATE_DIR:join(dir,'must-not-create'),MIDNIGHT_SEED_FILE:join(dir,'missing-secret'),MIDNIGHT_INDEXER_URL:'http://127.0.0.1:1',TON_RPC_URL:'http://127.0.0.1:1'}});
const save=(dir:string,n:string,v:unknown)=>{const p=join(dir,n);writeFileSync(p,toJson(v,0));return p;};

test('claim relay defaults to verified preparation without wallet state or network access',async()=>withTempDir(dir=>{
 const config:BridgeConfig={network:'preprod',domain:'33'.repeat(32),midnightAddress:'44'.repeat(32),escrows:[wallet,other],committee:midnightCommittee()};
 const receipt:DepositReceipt={id:'55'.repeat(32),network:'ton-testnet',escrow:wallet,sequence:'0',asset:0,amount:'1',recipient:'66'.repeat(32),block:10,blockRoot:'test'};
 const digest=new BridgeClient(config,{call:async()=>{throw Error('must not submit');}}).claimDigest(receipt);
 const configFile=save(dir,'config.json',config),a=save(dir,'a.json',{receipt,attestation:{signer:0,signature:signClaim(digest,MIDNIGHT_SECRETS[0])}}),b=save(dir,'b.json',{receipt,attestation:{signer:2,signature:signClaim(digest,MIDNIGHT_SECRETS[2])}});
 const result=relay(dir,['claim',configFile,a,b]);
 assert.equal(result.status,0,result.stderr);const out=JSON.parse(result.stdout);
 assert.equal(out.circuit,'claim');assert.equal(out.network,'preprod');assert.equal(out.address,config.midnightAddress);
 const forged=save(dir,'forged.json',{receipt,attestation:{signer:2,signature:signClaim(digest,MIDNIGHT_SECRETS[1])}});
 const bad=relay(dir,['claim',configFile,a,forged]);assert.notEqual(bad.status,0);assert.match(bad.stderr,/invalid attestation/);
 assert.deepEqual(readdirSync(dir).sort(),['a.json','b.json','config.json','forged.json']);
}));

test('release relay defaults to printing a verified quorum release message without wallet state or network access',async()=>withTempDir(dir=>{
 const domain=Buffer.alloc(32,0x33),escrow=Address.parse(wallet),to=new Address(0,Buffer.alloc(32,12)),id=Buffer.alloc(32,0x55);
 const configFile=save(dir,'config.json',{network:'ton-testnet',domain:domain.toString('hex'),escrows:[wallet,other],committee:TON_COMMITTEE.map(k=>k.toString('hex')),walletKeyFile:join(dir,'missing-wallet.json')});
 const request={id:id.toString('hex'),asset:0,amount:'100',recipient:to.toRawString(),transactionId:'local'};
 const [sa,sb]=quorumSign(releaseDigest(escrow,domain,id,100n,to));
 const a=save(dir,'a.json',{request,signer:0,signature:sa.toString('hex')}),b=save(dir,'b.json',{request,signer:2,signature:sb.toString('hex')});
 const result=relay(dir,['release',configFile,b,a]);
 assert.equal(result.status,0,result.stderr);const out=JSON.parse(result.stdout);
 assert.equal(out.network,'ton-testnet');assert.equal(out.to,escrow.toRawString());assert.equal(out.value,toNano('0.2').toString());
 assert(Cell.fromBase64(out.body).equals(releaseBody(id,100n,to,0,2,sa,sb)));
 // A signature from another committee slot, or observers disagreeing on the request, is refused.
 const wrongSlot=save(dir,'c.json',{request,signer:1,signature:sb.toString('hex')});
 const bad=relay(dir,['release',configFile,a,wrongSlot]);assert.notEqual(bad.status,0);assert.match(bad.stderr,/invalid signature/);
 const other100=save(dir,'d.json',{request:{...request,amount:'101'},signer:2,signature:sb.toString('hex')});
 const disagree=relay(dir,['release',configFile,a,other100]);assert.notEqual(disagree.status,0);assert.match(disagree.stderr,/disagree/);
 assert.deepEqual(readdirSync(dir).sort(),['a.json','b.json','c.json','config.json','d.json']);
}));
