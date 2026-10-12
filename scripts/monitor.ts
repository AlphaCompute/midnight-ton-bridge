import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {RouteMonitor,type RouteSample} from '../src/route-monitor.js';
import {acquireLock} from '../src/environment.js';
const directory=resolve(process.env.BRIDGE_MONITOR_DIR??'.state/monitor');mkdirSync(directory,{recursive:true,mode:0o700});
const interval=Number(process.env.BRIDGE_MONITOR_INTERVAL_MS??60000),timeout=Number(process.env.BRIDGE_MONITOR_TIMEOUT_MS??45000),port=Number(process.env.BRIDGE_MONITOR_PORT??9095),threshold=Number(process.env.BRIDGE_MONITOR_FAILURE_THRESHOLD??3);
if(!Number.isSafeInteger(interval)||interval<1000||!Number.isSafeInteger(timeout)||timeout<1000||timeout>=interval||!Number.isInteger(port)||port<1||port>65535||!Number.isSafeInteger(threshold)||threshold<1)throw Error('Invalid monitor interval, timeout, port or failure threshold');
const lockDirectory=resolve(process.env.BRIDGE_MONITOR_LOCK_DIR??directory);mkdirSync(lockDirectory,{recursive:true,mode:0o700});
const unlock=acquireLock(resolve(lockDirectory,'monitor.lock'),{startedAt:new Date().toISOString()});let closing=false,child:ReturnType<typeof spawn>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
const monitor=new RouteMonitor(resolve(directory,'status.json'),threshold,interval*3);
// The compiled route check runs in a bounded child process (dist/scripts/check-route.js).
const checkPath=fileURLToPath(new URL('./check-route.js',import.meta.url));
const server=createServer((req,res)=>{
 if(req.url==='/metrics'){res.writeHead(200,{'content-type':'text/plain; version=0.0.4'});res.end(monitor.metrics());}
 else if(req.url==='/healthz'){const h=monitor.health();res.writeHead(h.healthy?200:503,{'content-type':'application/json'});res.end(JSON.stringify(h));}
 else{res.writeHead(404);res.end();}
});
function cleanup(){if(closing)return;closing=true;if(timer)clearTimeout(timer);child?.kill('SIGTERM');server.close();unlock();}
process.on('SIGINT',cleanup);process.on('SIGTERM',cleanup);
server.on('error',e=>{cleanup();console.error(e.message);process.exitCode=1;});
async function check(){
 let sample:RouteSample|null=null;
 try{
  sample=await new Promise<RouteSample|null>(resolve=>{
   const p=spawn(process.execPath,[checkPath],{stdio:['ignore','pipe','pipe'],env:process.env});child=p;let output='',size=0,killed=false;
   const kill=()=>{killed=true;p.kill('SIGKILL');};const deadline=setTimeout(kill,timeout);
   p.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1_000_000)kill();else output+=chunk.toString();});
   p.stderr.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1_000_000)kill();});
   p.once('error',()=>{clearTimeout(deadline);resolve(null);});
   p.once('close',code=>{clearTimeout(deadline);child=undefined;if(killed||code===null||code>1){resolve(null);return;}try{resolve(JSON.parse(output.slice(output.indexOf('{'))));}catch{resolve(null);}});
  });
 }catch{sample=null;}
 if(closing)return;
 const update=monitor.record(sample);if(update.changed)console.log(JSON.stringify({event:update.state.status==='healthy'?'route_recovered':'route_status_changed',...update.state}));
 if(process.argv.includes('--once')){process.exitCode=monitor.health().healthy?0:1;cleanup();return;}
 timer=setTimeout(check,interval);
}
server.listen(port,'127.0.0.1',()=>void check());
