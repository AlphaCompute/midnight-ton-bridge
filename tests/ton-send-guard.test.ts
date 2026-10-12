import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WalletContractV4} from '@ton/ton';
import {keyPairFromSeed} from '@ton/crypto';
import {assertTonSendAvailable,nextAttemptId,walletMessageExpired,WALLET_EXPIRY_MARGIN} from '../src/ton-send-guard.js';
import type {Entry} from '../src/journal.js';

const wallet='0:'+'11'.repeat(32),other='0:'+'22'.repeat(32);

test('new TON logical IDs cannot bypass ambiguous sends or reuse reserved sequences',()=>{
 const row=(stage:Entry['stage'],seqno=4):Entry=>({id:'prior',stage,payload:JSON.stringify({wallet,seqno}),transaction:'bytes',txid:'hash',error:null});
 for(const stage of ['prepared','sending'] as const)for(const next of [4,5])assert.throws(()=>assertTonSendAvailable([row(stage)],wallet,next),/Unresolved/);
 assert.throws(()=>assertTonSendAvailable([row('submitted')],wallet,4),/Unresolved/);
 assert.doesNotThrow(()=>assertTonSendAvailable([row('submitted')],wallet,5));
 assert.doesNotThrow(()=>assertTonSendAvailable([row('confirmed')],wallet,5));
 assert.doesNotThrow(()=>assertTonSendAvailable([row('sending')],other,4));
 assert.throws(()=>assertTonSendAvailable([{...row('sending'),payload:'bad'}],wallet,5),SyntaxError);
 assert.throws(()=>assertTonSendAvailable([row('submitted',-1)],wallet,5),/Invalid journal sequence/);
 assert.throws(()=>assertTonSendAvailable([],wallet,-1),/Invalid wallet sequence/);
});

test('only a provably expired, unconsumed wallet message may be marked rejected',()=>{
 const pair=keyPairFromSeed(Buffer.alloc(32,7)),w=WalletContractV4.create({workchain:0,publicKey:pair.publicKey}),validUntil=1_800_000_000;
 const boc=w.createTransfer({seqno:5,secretKey:pair.secretKey,messages:[],timeout:validUntil}).toBoc().toString('base64');
 assert.equal(walletMessageExpired(boc,5,5,validUntil+WALLET_EXPIRY_MARGIN+1),true);
 assert.equal(walletMessageExpired(boc,5,5,validUntil+WALLET_EXPIRY_MARGIN),false,'clock-skew margin required');
 assert.equal(walletMessageExpired(boc,5,6,validUntil+3600),false,'consumed sequence may be this message');
 assert.equal(walletMessageExpired(boc,5,4,validUntil+3600),false);
 assert.throws(()=>walletMessageExpired(boc,4,4,validUntil+3600),/does not match/);
 assert.throws(()=>walletMessageExpired(boc,5,5,1.5),/Invalid expiry evidence/);
});

test('a logical TON send may be retried only after every earlier attempt is a proven rejection',()=>{
 const rows=new Map<string,Entry>(),get=(id:string)=>rows.get(id),put=(id:string,stage:Entry['stage'])=>rows.set(id,{id,stage,payload:'{}',transaction:null,txid:null,error:null});
 assert.equal(nextAttemptId(get,'release:x'),'release:x');
 for(const stage of ['observed','prepared','sending','submitted','confirmed'] as const){put('release:x',stage);assert.throws(()=>nextAttemptId(get,'release:x'),/reconcile/);}
 put('release:x','rejected');assert.equal(nextAttemptId(get,'release:x'),'release:x#2');
 put('release:x#2','sending');assert.throws(()=>nextAttemptId(get,'release:x'),/reconcile/);
 put('release:x#2','rejected');assert.equal(nextAttemptId(get,'release:x'),'release:x#3');
});

test('a confirmed send is retried only with explicit on-chain proof, and never past an unresolved attempt',()=>{
 const rows=new Map<string,Entry>(),get=(id:string)=>rows.get(id),put=(id:string,stage:Entry['stage'])=>rows.set(id,{id,stage,payload:'{}',transaction:null,txid:null,error:null});
 put('release:x','confirmed');
 assert.throws(()=>nextAttemptId(get,'release:x'),/reconcile/);
 assert.equal(nextAttemptId(get,'release:x',{afterConfirmed:true}),'release:x#2');
 put('release:x#2','submitted');assert.throws(()=>nextAttemptId(get,'release:x',{afterConfirmed:true}),/reconcile/);
});
