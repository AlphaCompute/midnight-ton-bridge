import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** Runs `fn` with a fresh temporary directory, removed afterwards. */
export async function withTempDir<T>(fn:(dir:string)=>T|Promise<T>):Promise<T>{
 const dir=mkdtempSync(join(tmpdir(),'bridge-test-'));try{return await fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}
}
/** Synchronous variant for tests that must not await. */
export function withTempDirSync<T>(fn:(dir:string)=>T):T{
 const dir=mkdtempSync(join(tmpdir(),'bridge-test-'));try{return fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}
}
/** Sets (or, for `undefined`, deletes) environment variables around `fn`, restoring each key afterwards. */
export async function withEnv<T>(vars:Record<string,string|undefined>,fn:()=>T|Promise<T>):Promise<T>{
 const saved=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));
 const apply=(v:Record<string,string|undefined>)=>{for(const [k,x] of Object.entries(v))if(x===undefined)delete process.env[k];else process.env[k]=x;};
 apply(vars);try{return await fn();}finally{apply(saved);}
}
