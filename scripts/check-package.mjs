import {readFileSync} from 'node:fs';
const path=process.argv[2];if(!path)throw new Error('usage: node scripts/check-package.mjs PACK_JSON');
const [pack]=JSON.parse(readFileSync(path,'utf8'));
for(const {path:p} of pack.files){
 const parts=p.split('/');if(parts.some(x=>['.state','.tools','node_modules','output'].includes(x))||parts.at(-1)==='.env'||p.endsWith('secret.json'))throw new Error(`Private or generated local path in package: ${p}`);
}
for(const required of ['dist/src/sdk.js','dist/build/midnight/contract/index.js','LICENSE','docs/operations.md','examples/notes/env.example','examples/notes/index.html'])if(!pack.files.some(x=>x.path===required))throw new Error(`Missing ${required}`);
console.log(`Package passed: ${pack.files.length} files, ${pack.size} bytes, ${pack.shasum}`);
