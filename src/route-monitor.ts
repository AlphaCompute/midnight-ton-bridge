import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {writeFileAtomic} from './environment.js';
import {dirname} from 'node:path';
export type RouteSample={settled:boolean;issues:string[];checkedAt:string};
type MonitorState={version:1;lastCheck:number;lastSuccess:number|null;failures:number;status:'starting'|'healthy'|'degraded'|'alert';issues:string[]};
export class RouteMonitor {
 state:MonitorState;
 constructor(readonly file:string,readonly failureThreshold=3,readonly staleAfterMs=180_000){
  if(!Number.isSafeInteger(failureThreshold)||failureThreshold<1||!Number.isSafeInteger(staleAfterMs)||staleAfterMs<1000)throw Error('Invalid monitor limits');
  this.state={version:1,lastCheck:0,lastSuccess:null,failures:0,status:'starting',issues:[]};
  if(existsSync(file)){
   const saved=JSON.parse(readFileSync(file,'utf8')) as MonitorState;
   if(saved.version!==1||!Number.isSafeInteger(saved.lastCheck)||!Number.isSafeInteger(saved.failures)||saved.failures<0||!Array.isArray(saved.issues)||!['starting','healthy','degraded','alert'].includes(saved.status))throw Error('Invalid persisted monitor state');
   this.state=saved;
  }
 }
 record(sample:RouteSample|null,now=Date.now()){
  const prior=this.state.status;
  const timestamp=sample?Date.parse(sample.checkedAt):NaN;
  const valid=sample&&typeof sample.settled==='boolean'&&Array.isArray(sample.issues)&&sample.issues.every(x=>typeof x==='string')&&Number.isFinite(timestamp)&&timestamp<=now+5000&&now-timestamp<=this.staleAfterMs;
  const healthy=Boolean(valid&&sample.settled&&sample.issues.length===0);
  const failures=healthy?0:this.state.failures+1;
  this.state={version:1,lastCheck:now,lastSuccess:healthy?now:this.state.lastSuccess,failures,status:healthy?'healthy':failures>=this.failureThreshold?'alert':'degraded',issues:healthy?[]:valid?sample!.issues.length?sample!.issues:['Route is unsettled']:['Route check failed or returned stale/invalid evidence']};
  mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
  writeFileAtomic(this.file,JSON.stringify(this.state,null,2)+'\n');
  return {changed:prior!==this.state.status,state:this.state};
 }
 health(now=Date.now()){
  return {...this.state,healthy:this.state.status==='healthy'&&now>=this.state.lastCheck&&now-this.state.lastCheck<=this.staleAfterMs};
 }
 metrics(now=Date.now()){
  const h=this.health(now);
  return `# TYPE bridge_route_healthy gauge\nbridge_route_healthy ${h.healthy?1:0}\n# TYPE bridge_route_consecutive_failures gauge\nbridge_route_consecutive_failures ${h.failures}\n# TYPE bridge_route_last_check_seconds gauge\nbridge_route_last_check_seconds ${h.lastCheck/1000}\n# TYPE bridge_route_last_success_seconds gauge\nbridge_route_last_success_seconds ${(h.lastSuccess??0)/1000}\n`;
 }
}
