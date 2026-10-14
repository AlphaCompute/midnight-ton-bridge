import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/journal.js';
import {evidenceSteps} from '../scripts/lib/steps.js';

const setup=()=>{
 const journal=new Journal(':memory:'),evidence:{steps:Record<string,unknown>[]}={steps:[]},sent:string[]=[];let saves=0;
 const steps=evidenceSteps(evidence,()=>{saves++;},journal,async id=>{sent.push(id);return {id,status:'sent'};});
 const record=(id:string,stage:'confirmed'|'rejected'|'sending')=>{journal.observe(id,'{}');journal.move(id,'observed','prepared',{tx:'b',txid:'h'});if(stage!=='rejected'){journal.move(id,'prepared','sending');if(stage==='confirmed')journal.move(id,'sending','confirmed');}else journal.move(id,'prepared','rejected');};
 return {journal,evidence,sent,steps,record,saves:()=>saves};
};

test('a resumed demo never resends a TON transfer that executed or may have executed',async()=>{
 const s=setup();
 // First run: sent and recorded as a step.
 await s.steps.tonOnce('deposit:0',[]);assert.deepEqual(s.sent,['deposit:0']);
 // Resume: the recorded step is reused, nothing is sent.
 await s.steps.tonOnce('deposit:0',[]);assert.deepEqual(s.sent,['deposit:0']);
 // Executed but the step was not saved (crash after the send): reconcile confirmed it.
 s.record('deposit:1','confirmed');const step=await s.steps.tonOnce('deposit:1',[]);
 assert.equal(step.id,'deposit:1');assert.deepEqual(s.sent,['deposit:0']);
 // Unresolved: the run stops until reconcile:ton has settled it.
 s.record('deposit:2','sending');await assert.rejects(()=>s.steps.tonOnce('deposit:2',[]),/reconcile:ton/);assert.deepEqual(s.sent,['deposit:0']);
 // Proven rejected: a new attempt is sent.
 s.record('deposit:3','rejected');await s.steps.tonOnce('deposit:3',[]);assert.deepEqual(s.sent,['deposit:0','deposit:3']);
 s.journal.close();
});

test('evidence steps are keyed so retried attempts, receipts and repeated circuits resume correctly',async()=>{
 const s=setup();
 s.evidence.steps.push({id:'mint:1#3'},{deposit:{asset:1}},{circuit:'claim'},{circuit:'claim'},{key:'refund',query:'4'});
 const done=s.steps.done();
 for(const key of ['mint:1','receipt:1','claim:0','claim:1','refund'])assert(done.has(key),key);
 // once() reuses a recorded result instead of running again.
 let runs=0;const again=await s.steps.once('refund',async()=>{runs++;return {query:'9'};});
 assert.equal(runs,0);assert.equal(again.query,'4');
 const fresh=await s.steps.once('before',async()=>{runs++;return {locked:'1'};});assert.equal(runs,1);assert.equal(fresh.key,'before');assert(s.saves()>0);
 s.journal.close();
});
