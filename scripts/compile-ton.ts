import { runTolkCompiler } from '@ton/tolk-js';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
export async function compileTon(name: string) {
  const result = await runTolkCompiler({entrypointFileName:`contracts/ton/${name}.tolk`, fsReadCallback:p=>readFileSync(p,'utf8')});
  if (result.status === 'error') throw new Error(result.message);
  mkdirSync('build/ton',{recursive:true});
  writeFileSync(`build/ton/${name}.json`,JSON.stringify(result,null,2));
  return result;
}
if (process.argv[1]?.endsWith('compile-ton.ts')) {
  for (const name of ['escrow', 'test-wallet', 'test-minter']) { const r = await compileTon(name); console.log(`${name}: ${r.codeHashHex}`); }
}
