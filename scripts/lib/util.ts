import {readFileSync} from 'node:fs';
import {Cell} from '@ton/core';

/** Compiled TON contract code from `npm run compile:ton` output in build/ton. */
export const loadTonCode=(name:string)=>Cell.fromBase64(JSON.parse(readFileSync(`build/ton/${name}.json`,'utf8')).codeBoc64);
/** Retries `fn` until it succeeds or the deadline passes, then rethrows its last error. */
export async function waitFor<T>(fn:()=>Promise<T>,{timeoutMs=180000,intervalMs=3000}={}):Promise<T>{
 const end=Date.now()+timeoutMs;let error:unknown;
 while(Date.now()<end){try{return await fn();}catch(e){error=e;}await new Promise(r=>setTimeout(r,intervalMs));}
 throw error;
}
/** Boolean CLI flag. */
export const flag=(name:string)=>process.argv.includes(name);
