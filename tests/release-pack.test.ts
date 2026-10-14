import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The release tooling is plain JavaScript without type declarations.
import {checkPack,privatePathReason} from '../scripts/lib/pack-check.mjs';

const REQUIRED=['dist/src/index.js','dist/src/sdk.js','dist/build/midnight/contract/index.js','README.md','LICENSE','docs/operations.md','examples/notes/env.example','examples/notes/index.html'];
const pack=(...extra:string[])=>({files:[...REQUIRED,...extra].map(path=>({path})),size:1,shasum:'x'});

test('the published package refuses keys, seeds, provider tokens, journals and local state',()=>{
 for(const path of ['infrastructure/monitor/monitor.env','.env','.env.local','.npmrc','.state/preprod/route.env','docs/ton-test-wallet.json','midnight-test-wallet.json',
  'demo-operators.json','testnet-redemption-nonce.json','acton-mnemonic.txt','operator/secret.json','wallets.toml','ton-transactions.sqlite','x.sqlite-journal','ton-wallet.lock','logs/run.txt','output/handoff/a.tgz'])
  assert.throws(()=>checkPack(pack(path)),/Private or generated/,path);
 for(const path of ['.env.example','infrastructure/monitor/monitor.env.example','examples/notes/env.example','infrastructure/local-indexer.env','src/environment.ts','docs/evidence/testnet-deployment.json','package.json'])
  assert.equal(privatePathReason(path),undefined,path);
 assert.match(checkPack(pack()),/Package passed/);
 assert.throws(()=>checkPack({files:[{path:'README.md'}],size:1,shasum:'x'}),/Missing dist\/src\/index.js/);
});
