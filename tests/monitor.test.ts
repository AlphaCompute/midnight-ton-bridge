import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {RouteMonitor} from '../src/route-monitor.js';
import {withTempDir} from './helpers/env.js';

const now=1_700_000_000_000,at=(t:number)=>new Date(t).toISOString();

test('route monitor: health requires a fresh settled check',async()=>withTempDir(dir=>{
 const m=new RouteMonitor(join(dir,'status.json'),2,5000);assert.equal(m.health(now).healthy,false);assert.equal(m.state.status,'starting');
 m.record({settled:true,issues:[],checkedAt:at(now)},now);assert.equal(m.health(now+4999).healthy,true);assert.equal(m.health(now+5001).healthy,false);
 m.record(null,now+1000);assert.equal(m.state.status,'degraded');assert.equal(m.state.failures,1);
}));

test('route monitor: failures persist across restart and escalate; stale or issue-bearing samples never recover',async()=>withTempDir(dir=>{
 const file=join(dir,'status.json');
 new RouteMonitor(file,2,5000).record(null,now+1000);
 const m=new RouteMonitor(file,2,5000);assert.equal(m.state.failures,1);
 const r=m.record({settled:false,issues:['backing mismatch'],checkedAt:at(now+2000)},now+2000);
 assert.equal(r.changed,true);assert.equal(m.state.status,'alert');assert.deepEqual(m.state.issues,['backing mismatch']);assert.equal(m.health(now+2000).healthy,false);
 m.record({settled:true,issues:[],checkedAt:at(now-10000)},now+3000);assert.equal(m.state.status,'alert');
 m.record({settled:true,issues:['unresolved send'],checkedAt:at(now+4000)},now+4000);assert.equal(m.state.status,'alert');
 m.record({settled:true,issues:[],checkedAt:at(now+5000)},now+5000);assert.equal(m.state.status,'healthy');assert.equal(m.state.failures,0);
 assert.match(m.metrics(now+5000),/bridge_route_healthy 1/);assert.equal(JSON.parse(readFileSync(file,'utf8')).lastSuccess,now+5000);
}));

test('route monitor: invalid limits and corrupt persisted state are rejected',async()=>withTempDir(dir=>{
 const file=join(dir,'status.json');
 assert.throws(()=>new RouteMonitor(file,0),/Invalid monitor limits/);assert.throws(()=>new RouteMonitor(file,1,999),/Invalid monitor limits/);
 writeFileSync(file,JSON.stringify({version:1,lastCheck:0,lastSuccess:null,failures:-1,status:'healthy',issues:[]}));
 assert.throws(()=>new RouteMonitor(file),/Invalid persisted monitor state/);
}));
