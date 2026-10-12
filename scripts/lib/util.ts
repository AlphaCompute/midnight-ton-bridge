import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {readSecret,statePath} from '../../src/environment.js';
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
/** Owner-only random 32-byte secret in the state directory, created on first use and
 * reused afterwards, so a resumed run never replaces an LP secret or redemption nonce. */
export function stateSecret(name:string){
 const p=statePath(name);if(!existsSync(p))writeFileSync(p,JSON.stringify({secret:randomBytes(32).toString('hex')}),{mode:0o600,flag:'wx'});
 return Buffer.from(readSecret<{secret:string}>(p).secret,'hex');
}
