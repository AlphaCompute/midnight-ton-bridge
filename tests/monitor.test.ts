import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {RouteMonitor} from '../src/monitor.js';
test('monitor persists failures across restart, detects stale evidence and recovers only on settled checks',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bridge-monitor-'));try{
  const file=join(dir,'status.json'),now=1_700_000_000_000;
  let m=new RouteMonitor(file,2,5000);assert.equal(m.health(now).healthy,false);
  m.record({settled:true,issues:[],checkedAt:new Date(now).toISOString()},now);assert.equal(m.health(now+4999).healthy,true);assert.equal(m.health(now+5001).healthy,false);
  m.record(null,now+1000);assert.equal(m.state.status,'degraded');
  m=new RouteMonitor(file,2,5000);m.record({settled:false,issues:['backing mismatch'],checkedAt:new Date(now+2000).toISOString()},now+2000);assert.equal(m.state.status,'alert');assert.equal(m.health(now+2000).healthy,false);
  m.record({settled:true,issues:[],checkedAt:new Date(now-10000).toISOString()},now+3000);assert.equal(m.state.status,'alert');
  m.record({settled:true,issues:['unresolved send'],checkedAt:new Date(now+4000).toISOString()},now+4000);assert.equal(m.state.status,'alert');
  m.record({settled:true,issues:[],checkedAt:new Date(now+5000).toISOString()},now+5000);assert.equal(m.state.status,'healthy');assert.equal(m.state.failures,0);assert.match(m.metrics(now+5000),/bridge_route_healthy 1/);assert.equal(JSON.parse(readFileSync(file,'utf8')).lastSuccess,now+5000);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
