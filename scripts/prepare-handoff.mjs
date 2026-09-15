import {readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
const root=resolve('output/handoff');mkdirSync(root,{recursive:true});
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const starter=join(root,'notes-starter');mkdirSync(starter,{recursive:true});
for(const name of readdirSync('examples/notes'))if(/\.(mjs|html|md|json)$/.test(name)||name==='env.example')copyFileSync(join('examples/notes',name),join(starter,name));
for(const name of ['README.md','LICENSE'])copyFileSync(name,join(root,name));
const docs=['deployment.md','acceptance.md','architecture.md','operations.md','security-review.md','security-review.pdf','validation.md','standard-recovery.md','standard-testnet-evidence.json','standard-testnet-deployment.json','standard-testnet-assets.json','standard-testnet-accounting.json','benchmarks.json','external-release-inputs.md','monitoring.md','delivery-artifacts.md','security-review-ipfs.json'];
mkdirSync(join(root,'docs'),{recursive:true});for(const name of docs)copyFileSync(join('docs',name),join(root,'docs',name));
execFileSync('git',['archive','--format=tar.gz',`--output=${join(root,'bridge-source.tar.gz')}`,head]);
const [pack]=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',root],{encoding:'utf8'}));
copyFileSync('LICENSE',join(starter,'LICENSE'));
const starterPackage=JSON.parse(readFileSync(join(starter,'package.json'),'utf8'));mkdirSync(join(starter,'vendor'),{recursive:true});copyFileSync(join(root,pack.filename),join(starter,'vendor',pack.filename));starterPackage.dependencies['@alphaton/midnight-ton-bridge']='file:vendor/'+pack.filename;writeFileSync(join(starter,'package.json'),JSON.stringify(starterPackage,null,2)+'\n');
writeFileSync(join(starter,'README.md'),`# Midnight bridge notes starter

Private standalone starter with a pinned vendored bridge SDK. Requires Node 24.

Run npm ci, npm test, copy env.example to .env, then npm start. Open http://127.0.0.1:3077.

The default local-memory note flow works without credentials. Configure the bridge using env.example and the delivered bridge README. Notes clear on restart; this is not an encrypted production notes service or the whistleblower application. No wallet keys are bundled and the starter prepares unsigned transactions only.
`);
execFileSync('npm',['install','--package-lock-only','--ignore-scripts'],{cwd:starter,stdio:'pipe'});
const files=['notes-starter/vendor/'+pack.filename,...docs.map(n=>'docs/'+n),'README.md','LICENSE','bridge-source.tar.gz',pack.filename,...readdirSync(starter,{withFileTypes:true}).filter(e=>e.isFile()).map(e=>'notes-starter/'+e.name)];
const sha256=Object.fromEntries(files.sort().map(n=>[n,createHash('sha256').update(readFileSync(join(root,n))).digest('hex')]));
writeFileSync(join(root,'handoff-manifest.json'),JSON.stringify({sourceCommit:head,generatedAt:new Date().toISOString(),sha256,notes:'Private delivery bundle. No deployed wallet keys, LP secrets, signed commercial agreement or node state are included. Independent build, issuer approval and Foundation acceptance are not established by this bundle.'},null,2)+'\n');
console.log(`Prepared ${files.length} checksummed files in ${root}`);
