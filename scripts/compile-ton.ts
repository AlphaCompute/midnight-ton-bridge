import {compileFunc} from '@ton-community/func-js';
import {Cell} from '@ton/core';
import { runTolkCompiler } from '@ton/tolk-js';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
export async function compileTon(name: string) {
  if(name==='reference-wallet'||name==='reference-minter') {
    const root='contracts/ton/reference/';
    const result=await compileFunc({targets:['stdlib.fc','params.fc','op-codes.fc','jetton-utils.fc',name.replace('reference','jetton')+'.fc'].map(p=>root+p),sources:p=>readFileSync(p,'utf8')});
    if(result.status==='error')throw new Error(result.message);
    const output={codeBoc64:result.codeBoc,codeHashHex:Cell.fromBase64(result.codeBoc).hash().toString('hex')};
    mkdirSync('build/ton',{recursive:true});writeFileSync(`build/ton/${name}.json`,JSON.stringify(output,null,2));return output;
  }
  const result = await runTolkCompiler({entrypointFileName:`contracts/ton/${name}.tolk`, fsReadCallback:p=>readFileSync(p,'utf8')});
  if (result.status === 'error') throw new Error(result.message);
  mkdirSync('build/ton',{recursive:true});
  writeFileSync(`build/ton/${name}.json`,JSON.stringify(result,null,2));
  return result;
}
if (process.argv[1]?.endsWith('compile-ton.ts')) {
  for (const name of ['escrow-standard', 'reference-wallet', 'reference-minter']) { const r = await compileTon(name); console.log(`${name}: ${r.codeHashHex}`); }
}
