import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Journal,advance,type Destination} from '../src/journal.js';
test('durable ambiguous submission reconciles after restart without a duplicate send',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'bridge-journal-')),'journal.sqlite');let sends=0;
 const d:Destination={prepare:async()=>({bytes:'exact-signed-transaction',id:'tx1'}),submit:async()=>{sends++;throw new Error('connection lost after broadcast');},reconcile:async()=>'confirmed'};
 let j=new Journal(path);j.observe('r1','{"amount":"10"}');assert.equal((await advance(j,'r1',d)).stage,'sending');j.close();
 j=new Journal(path);assert.equal((await advance(j,'r1',d)).stage,'confirmed');assert.equal(sends,1);
 assert.throws(()=>j.observe('r1','{"amount":"11"}'),/conflicting payload/);j.close();
});
test('compare-and-set prevents duplicate workers; unknown is never promoted to final',async()=>{
 const j=new Journal(':memory:');j.observe('r','payload');j.move('r','observed','prepared','bytes','tx');
 j.move('r','prepared','sending');assert.throws(()=>j.move('r','prepared','sending'),/lost race/);
 const d:Destination={prepare:async()=>{throw Error('not called');},submit:async()=>{throw Error('not called');},reconcile:async()=>'unknown'};
 assert.equal((await advance(j,'r',d)).stage,'sending');j.close();
});
