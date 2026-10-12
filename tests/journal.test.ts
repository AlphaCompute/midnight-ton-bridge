import {test} from 'node:test';
import assert from 'node:assert/strict';
import {statSync} from 'node:fs';
import {join} from 'node:path';
import {Journal,PENDING_STAGES,isPending,type Stage} from '../src/journal.js';
import {withTempDir} from './helpers/env.js';

test('an ambiguous send survives a restart as pending, with its exact transaction, and is never re-prepared',async()=>withTempDir(dir=>{
 const path=join(dir,'journal.sqlite');
 let j=new Journal(path);j.observe('r1','{"amount":"10"}');
 j.move('r1','observed','prepared',{tx:'exact-signed-transaction',txid:'tx1'});j.move('r1','prepared','sending');j.close();
 assert.equal(statSync(path).mode&0o777,0o600);
 j=new Journal(path);
 try{
  assert.deepEqual({...j.get('r1')},{id:'r1',payload:'{"amount":"10"}',stage:'sending',transaction:'exact-signed-transaction',txid:'tx1',error:null});
  assert.deepEqual(j.pending().map(e=>e.id),['r1']);
  // Re-observing the same payload is idempotent; a different payload for the same ID is refused.
  assert.equal(j.observe('r1','{"amount":"10"}').stage,'sending');
  assert.throws(()=>j.observe('r1','{"amount":"11"}'),/conflicting payload/);
  assert.throws(()=>j.move('r1','observed','prepared',{tx:'other',txid:'tx2'}),/lost race/);
  // Reconciliation keeps the transaction and records the outcome.
  const done=j.move('r1','sending','confirmed');assert.equal(done.transaction,'exact-signed-transaction');assert.equal(done.txid,'tx1');
  assert.deepEqual(j.pending(),[]);
 }finally{j.close();}
}));

test('compare-and-set transitions: lost races, required transactions and invalid transitions fail closed',()=>{
 const j=new Journal(':memory:');
 try{
  j.observe('r','payload');
  assert.throws(()=>j.move('r','observed','prepared'),/prepared transaction required/);
  assert.throws(()=>j.move('r','observed','prepared',{tx:'bytes'}),/prepared transaction required/);
  j.move('r','observed','prepared',{tx:'bytes',txid:'tx'});
  j.move('r','prepared','sending');assert.throws(()=>j.move('r','prepared','sending'),/lost race/);
  for(const [from,to] of [['sending','prepared'],['sending','observed'],['observed','confirmed'],['confirmed','rejected'],['rejected','observed']] as [Stage,Stage][])assert.throws(()=>j.move('r',from,to),/invalid transition/);
  assert.throws(()=>j.move('missing','sending','submitted'),/lost race/);
  assert.equal(j.move('r','sending','rejected',{error:'expired'}).error,'expired');
  j.observe('a','x');j.observe('b','y');j.move('b','observed','prepared',{tx:'t',txid:'i'});
  assert.deepEqual(j.list().map(e=>[e.id,e.stage]),[['a','observed'],['b','prepared'],['r','rejected']]);
  assert.deepEqual(j.pending().map(e=>e.id),['b']);
  assert.deepEqual([...PENDING_STAGES],['prepared','sending','submitted']);
  assert.deepEqual((['observed','prepared','sending','submitted','confirmed','rejected'] as Stage[]).filter(isPending),[...PENDING_STAGES]);
 }finally{j.close();}
});
