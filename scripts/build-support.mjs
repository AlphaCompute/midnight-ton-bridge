// Build helpers: `check` rejects stale Compact bindings; `clean` empties dist so modules
// deleted from the source never ship; `copy` places the bindings beside dist/src.
import {cpSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [command]=process.argv.slice(2);
if(command==='check'){
 const hash=createHash('sha256').update(readFileSync('contracts/midnight/bridge.compact')).digest('hex');
 let fingerprint='';try{fingerprint=readFileSync('build/midnight/.source-fingerprint','utf8');}catch{}
 if(!fingerprint.startsWith(hash+'-'))throw new Error('Missing or stale Compact bindings. Run npm run compile:midnight before build/test.');
}else if(command==='clean'){
 rmSync('dist',{recursive:true,force:true});
}else if(command==='copy'){
 mkdirSync('dist/build/midnight',{recursive:true});cpSync('build/midnight/contract','dist/build/midnight/contract',{recursive:true});
}else throw new Error('usage: node scripts/build-support.mjs check|clean|copy');
