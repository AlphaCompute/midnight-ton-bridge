import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(`${dir}/${e.name}`):[`${dir}/${e.name}`]);
const paths=[...walk('contracts'),...walk('src'),...walk('scripts'),...walk('tests'),'package.json','package-lock.json','tsconfig.json',...walk('build/ton'),...walk('build/midnight/keys')].sort();
const files=Object.fromEntries(paths.map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
writeFileSync('docs/build-manifest.json',JSON.stringify({algorithm:'sha256',compiler:'0.31.1',node:process.version,files},null,2)+'\n');
console.log(`Recorded ${paths.length} source, test and artifact hashes`);
