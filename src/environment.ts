import {closeSync,mkdirSync,openSync,readFileSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
export type Network='local'|'preprod'|'mainnet';
/** Networks this release may transact on. */
export type TestNetwork=Exclude<Network,'mainnet'>;
export function network():Network{
 const value=process.env.BRIDGE_NETWORK??process.env.MIDNIGHT_NETWORK??'local';
 if(!['local','preprod','mainnet'].includes(value))throw new Error('unknown bridge network');
 if(process.env.BRIDGE_NETWORK&&process.env.MIDNIGHT_NETWORK&&process.env.BRIDGE_NETWORK!==process.env.MIDNIGHT_NETWORK)throw new Error('conflicting network configuration');
 return value as Network;
}
export function stateDirectory(){const n=network(),dir=resolve(process.env.BRIDGE_STATE_DIR??(n==='local'?'.state':`.state/${n}`));mkdirSync(dir,{recursive:true,mode:0o700});return dir;}
export function statePath(name:string){if(!name||name.includes('/')||name==='..')throw new Error('invalid state file');return join(stateDirectory(),name);}
export const readJson=<T=any>(path:string):T=>JSON.parse(readFileSync(path,'utf8')) as T;
/** Parsed JSON file from the state directory. */
export const readState=<T=any>(name:string):T=>readJson<T>(statePath(name));
export function readSecret<T>(path:string):T{
 const stat=statSync(path);if(!stat.isFile()||(stat.mode&0o077)!==0)throw new Error('secret file must be a regular owner-only file (chmod 600)');
 return readJson<T>(path);
}
/** Agreed 32-byte route domain shared by both chains' deployments. */
export function routeDomain(value=process.env.BRIDGE_DOMAIN):Buffer{
 if(!value||!/^[a-f0-9]{64}$/i.test(value))throw new Error('Set BRIDGE_DOMAIN to the agreed 32-byte route-domain hex');
 return Buffer.from(value,'hex');
}
let signalExit=false;
/** Exclusive owner-only lock file; throws if held. Returns an idempotent release, also run
 * when the process exits. With `exitOnSignal`, Ctrl-C and SIGTERM exit (and so release)
 * instead of leaving a stale lock; journals, not locks, prevent duplicate transactions. */
export function acquireLock(path:string,info:Record<string,unknown>={},{exitOnSignal=false}={}){
 const fd=openSync(path,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,...info}));
 let held=true;const release=()=>{if(!held)return;held=false;process.off('exit',release);closeSync(fd);unlinkSync(path);};
 process.once('exit',release);
 if(exitOnSignal&&!signalExit){signalExit=true;process.once('SIGINT',()=>process.exit(130));process.once('SIGTERM',()=>process.exit(143));}
 return release;
}
/** Write through a temporary file and rename, so readers never see a partial file. */
export function writeFileAtomic(path:string,data:string,mode=0o600){const tmp=path+'.tmp';writeFileSync(tmp,data,{mode});renameSync(tmp,path);}
