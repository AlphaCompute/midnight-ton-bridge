// Build helpers: `check` rejects stale Compact bindings and keys; `clean` empties dist so
// modules deleted from the source never ship; `copy` places the bindings beside dist/src;
// `pins` checks this source reproduces the published testnet route.
import {cpSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [command]=process.argv.slice(2);
if(command==='check'){
 const hash=createHash('sha256').update(readFileSync('contracts/midnight/bridge.compact')).digest('hex');
 let fingerprint='';try{fingerprint=readFileSync('build/midnight/.source-fingerprint','utf8');}catch{}
 if(!fingerprint.startsWith(hash+'-'))throw new Error('Missing or stale Compact bindings. Run npm run compile:midnight before build/test.');
 // Proving keys are optional, but present keys must come from the same source and compiler.
 let keys;try{keys=readFileSync('build/midnight/keys/.source-fingerprint','utf8');}catch{}
 if(keys!==undefined&&keys!==fingerprint)throw new Error('Stale Midnight proving keys. Run npm run compile:midnight -- --proof.');
}else if(command==='pins'){
 // The published testnet route must be reproducible from this source: TON escrow code and,
 // when proving keys are built, every Midnight verifier key.
 const d=JSON.parse(readFileSync('docs/evidence/testnet-deployment.json','utf8'));
 const code=JSON.parse(readFileSync('build/ton/escrow-standard.json','utf8')).codeHashHex.toLowerCase();
 for(const a of d.ton)if(a.codeHash!==code)throw new Error(`escrow ${a.escrow} code ${a.codeHash} is not reproduced by this source (${code})`);
 let checked=0;
 for(const [name,pin] of Object.entries(d.pins.verifiers)){let key;try{key=readFileSync(`build/midnight/keys/${name}.verifier`);}catch{continue;}
  if(createHash('sha256').update(key).digest('hex')!==pin)throw new Error(`verifier ${name} does not match the deployed route`);checked++;}
 console.log(`Source reproduces the published route: escrow code${checked?` and ${checked} verifier keys`:' (verifier keys not built)'}`);
}else if(command==='clean'){
 rmSync('dist',{recursive:true,force:true});
}else if(command==='copy'){
 mkdirSync('dist/build/midnight',{recursive:true});cpSync('build/midnight/contract','dist/build/midnight/contract',{recursive:true});
}else throw new Error('usage: node scripts/build-support.mjs check|clean|copy|pins');
