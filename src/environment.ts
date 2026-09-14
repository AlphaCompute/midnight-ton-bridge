import {mkdirSync,readFileSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
export type Network='local'|'preprod'|'mainnet';
export function network():Network{
 const value=process.env.BRIDGE_NETWORK??process.env.MIDNIGHT_NETWORK??'local';
 if(!['local','preprod','mainnet'].includes(value))throw new Error('unknown bridge network');
 if(process.env.BRIDGE_NETWORK&&process.env.MIDNIGHT_NETWORK&&process.env.BRIDGE_NETWORK!==process.env.MIDNIGHT_NETWORK)throw new Error('conflicting network configuration');
 return value as Network;
}
export function stateDirectory(){const n=network(),dir=resolve(process.env.BRIDGE_STATE_DIR??(n==='local'?'.state':`.state/${n}`));mkdirSync(dir,{recursive:true,mode:0o700});return dir;}
export function statePath(name:string){if(name.includes('/')||name==='..')throw new Error('invalid state file');return join(stateDirectory(),name);}
export function readSecret<T>(path:string):T{
 const stat=statSync(path);if(!stat.isFile()||(stat.mode&0o077)!==0)throw new Error('secret file must be a regular owner-only file (chmod 600)');
 return JSON.parse(readFileSync(path,'utf8')) as T;
}
