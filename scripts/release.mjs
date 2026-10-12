// Release tooling. Run from a clean checkout of the reviewed commit:
//   manifest            hash sources, tests, TON code and proof keys into docs/evidence/build-manifest.json
//   benchmarks          summarize the six measured testnet calls into docs/evidence/benchmarks.json
//   handoff             build the private delivery bundle in output/handoff
//   video               (macOS) narrated walkthrough of finalized evidence in output/demo
//   check-package PACK  reject private paths and missing files in `npm pack --json` output
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,cpSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {cpus,platform,arch} from 'node:os';
import {join,resolve} from 'node:path';
const [command,arg]=process.argv.slice(2);
const readJson=p=>JSON.parse(readFileSync(p,'utf8'));
const sha256=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(`${dir}/${e.name}`):[`${dir}/${e.name}`]);
const COMPACT_VERSION=/COMPACT_VERSION=(\S+)/.exec(readFileSync('scripts/toolchain.env','utf8'))[1];
const EVIDENCE='docs/evidence',TRANSACTIONS=`${EVIDENCE}/testnet-transactions.json`;
const commands={
 manifest(){
  const paths=[...walk('contracts'),...walk('src'),...walk('scripts'),...walk('tests'),'package.json','package-lock.json','tsconfig.json',...walk('build/ton'),...walk('build/midnight/keys')].sort();
  writeFileSync(`${EVIDENCE}/build-manifest.json`,JSON.stringify({algorithm:'sha256',compiler:COMPACT_VERSION,node:process.version,files:Object.fromEntries(paths.map(p=>[p,sha256(p)]))},null,2)+'\n');
  console.log(`Recorded ${paths.length} source, test and artifact hashes`);
 },
 benchmarks(){
  const evidence=readJson(TRANSACTIONS);if(!evidence.complete)throw Error('Completed evidence required');
  const rows=evidence.steps.filter(s=>s.circuit).map(s=>({circuit:s.circuit,milliseconds:s.milliseconds,transactionId:s.txId,blockHeight:s.blockHeight}));
  if(rows.length!==6||rows.some(r=>!Number.isFinite(r.milliseconds)||r.milliseconds<=0))throw Error('Missing measured duration');
  const sorted=rows.map(r=>r.milliseconds).sort((a,b)=>a-b),report={scope:'Six sequential successful calls in one public testnet round trip; total call duration includes transaction preparation, proof, broadcast and finality. Not isolated proving time or a throughput benchmark.',machine:{platform:platform(),architecture:arch(),cpu:cpus()[0]?.model,node:process.version},rows,summary:{samples:rows.length,totalMilliseconds:sorted.reduce((a,b)=>a+b,0),medianMilliseconds:(sorted[2]+sorted[3])/2,minimumMilliseconds:sorted[0],maximumMilliseconds:sorted.at(-1)},limits:['No concurrency/load test was performed.','No throughput or latency SLA is inferred from six samples.','Production performance targets require explicit acceptance.']};
  writeFileSync(`${EVIDENCE}/benchmarks.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.summary));
 },
 handoff(){
  const root=resolve('output/handoff');mkdirSync(root,{recursive:true});
  const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const starter=join(root,'notes-starter');mkdirSync(starter,{recursive:true});
  for(const name of readdirSync('examples/notes'))if(/\.(mjs|html|md|json)$/.test(name)||name==='env.example')copyFileSync(join('examples/notes',name),join(starter,name));
  for(const name of ['README.md','LICENSE'])copyFileSync(name,join(root,name));
  // The whole docs tree (guides and every evidence record), so its relative links resolve in the bundle.
  cpSync('docs',join(root,'docs'),{recursive:true});const docs=walk('docs').map(p=>p.slice('docs/'.length));
  execFileSync('git',['archive','--format=tar.gz',`--output=${join(root,'bridge-source.tar.gz')}`,head]);
  const [pack]=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',root],{encoding:'utf8'}));
  copyFileSync('LICENSE',join(starter,'LICENSE'));
  const starterPackage=readJson(join(starter,'package.json'));mkdirSync(join(starter,'vendor'),{recursive:true});copyFileSync(join(root,pack.filename),join(starter,'vendor',pack.filename));starterPackage.dependencies['@alphaton/midnight-ton-bridge']='file:vendor/'+pack.filename;writeFileSync(join(starter,'package.json'),JSON.stringify(starterPackage,null,2)+'\n');
  execFileSync('npm',['install','--package-lock-only','--ignore-scripts'],{cwd:starter,stdio:'pipe'});
  const files=['notes-starter/vendor/'+pack.filename,...docs.map(n=>'docs/'+n),'README.md','LICENSE','bridge-source.tar.gz',pack.filename,...readdirSync(starter,{withFileTypes:true}).filter(e=>e.isFile()).map(e=>'notes-starter/'+e.name)];
  writeFileSync(join(root,'handoff-manifest.json'),JSON.stringify({sourceCommit:head,generatedAt:new Date().toISOString(),sha256:Object.fromEntries(files.sort().map(n=>[n,sha256(join(root,n))])),notes:'Private delivery bundle. No deployed wallet keys, LP secrets, signed commercial agreement or node state are included. Independent build, issuer approval and Foundation acceptance are not established by this bundle.'},null,2)+'\n');
  console.log(`Prepared ${files.length} checksummed files in ${root}`);
 },
 // macOS narration/render helper (say, ffmpeg, Python with Pillow). Reviews existing
 // finalized evidence; never fabricates a live capture or broadcasts transactions.
 video(){
  const e=readJson(TRANSACTIONS),d=readJson(`${EVIDENCE}/testnet-deployment.json`),b=readJson(`${EVIDENCE}/benchmarks.json`);
  if(!e.complete||!e.independentReadback?.allSixCallsFinalized)throw Error('Verified completed evidence required');
  const testCount=readdirSync('tests').filter(n=>n.endsWith('.test.ts')).reduce((n,f)=>n+(readFileSync(join('tests',f),'utf8').match(/^test\(/gm)?.length??0),0);
  const root=resolve('output/demo');mkdirSync(root,{recursive:true});
  const chapters=[
   ['Midnight - TON bridge','Finalized testnet evidence walkthrough\nTON testnet + Midnight preprod\nAI-narrated review; not a new transaction recording', 'This is a narrated walkthrough of the completed Midnight TON bridge testnet demonstration. It reviews finalized transaction evidence, rather than broadcasting a fresh transaction or pretending to be a live screen recording. The network tokens are valueless and are not issuer approved WHIS or USD1.'],
   ['Two-chain bridge deployment',`Midnight: ${d.midnight.slice(0,28)}...\nTwo allowlisted TON jetton masters and escrows\nUnmodified TON reference wallets\nFixed two-of-three committee`, 'The bridge uses two allowlisted TON jetton escrows and a Midnight contract for representations, retirement and a two asset pool. The current route uses the unmodified TON reference wallet. Existing compatible masters can be configured without issuer mint authority. The testnet demonstration committee is held on one development host; production requires independent custody.'],
   ['Deposit and claim','10,000 base units deposited for each asset\nAuthenticated TON escrow receipts\nTwo finalized Midnight claims\nQuorum signatures bind route, amount and recipient', 'The recorded demonstration deposits ten thousand base units of each token into TON escrow. Each authenticated receipt is checked before the corresponding Midnight representation is claimed. The authorization binds the route, amount, asset and recipient. Both claims finalized successfully. Replay and altered authorization are rejected in the automated contract tests.'],
   ['Liquidity and swap','Add liquidity: 5,000 / 5,000 base units\nSwap: 100 units, bounded minimum output\nWithdraw all liquidity\nFinal pool reserves and shares: zero', 'Both assets are supplied to the Midnight pool. The demonstration adds five thousand units of each, swaps one hundred units, and withdraws all liquidity. The contract checks the reserve ratio, rounding, authorization and slippage. Pool reserves and liquidity shares return to zero. Bridge backing is separate from liquidity pool capital.'],
   ['Redemption and recipient delivery','Retire 100 units on Midnight\nRelease 100 units on TON\nSource and recipient message hashes match\nFinal backing = circulation: 9,900 / 10,000', 'The next step permanently retires one hundred representations on Midnight. Two signatures authorize their return on TON. Verification follows the matching outgoing and incoming message hashes and confirms successful recipient credit. Wallet submission alone is not treated as delivery. The final backing and circulating supply match at nine thousand nine hundred and ten thousand units.'],
   ['Recovery and operational checks',`${testCount} automated tests in the current release\nExact downstream-bounce recovery\nDurable transaction and signer journals\nMonitor health, metrics and failure alerts\nMeasured median call: ${(b.summary.medianMilliseconds/1000).toFixed(2)} seconds`, `Tests cover actual downstream failure and successful retry, forged evidence, replay, refunds, cryptographic constraints and accounting. Recovery restores only the exact pending instruction after independently observed failure. Transaction journals prevent blind replacement sends. The monitoring service exposes health and metrics, detects stale checks and retains failure state across restarts. The six measured calls have a median total call duration of about ${Math.round(b.summary.medianMilliseconds/1000)} seconds. This is not a throughput benchmark or a service guarantee.`],
   ['Handoff and release boundaries','README and guides: setup, testnet deployment and operations\nSDK, source, evidence and checksums\nMainnet broadcast remains disabled\nStill external: issuer approval, independent review,\ncustody and Foundation acceptance', 'The handoff includes the source, SDK, testnet evidence and checksums. The deployment and operations guides explain setup and running the bridge. Mainnet broadcast remains disabled until approved production assets, independent security review and operator custody are resolved. This implementing agent review is not an independent audit, and neither the software nor this recording substitutes for written Foundation acceptance.']
  ];
  writeFileSync(resolve(root,'transcript.txt'),chapters.map(([title,,n])=>title+'\n'+n).join('\n\n'));
  const outputs=[];
  for(const [i,[title,body,narration]]of chapters.entries()){
   const stem=resolve(root,`chapter-${i}`);writeFileSync(stem+'.txt',title+'\n\n'+body+'\n\nEvidence: '+TRANSACTIONS);writeFileSync(stem+'-voice.txt',narration);
   execFileSync('say',['-v','Samantha','-r','165','-f',stem+'-voice.txt','-o',stem+'.aiff']);
   execFileSync(process.env.BRIDGE_PYTHON??'python3',['-c',SLIDE_PY,stem,title,body]);
   execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-loop','1','-i',stem+'.png','-i',stem+'.aiff','-r','15','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-shortest',stem+'.mp4']);outputs.push(stem+'.mp4');
  }
  const list=resolve(root,'concat.txt');writeFileSync(list,outputs.map(p=>`file '${p}'`).join('\n'));
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',resolve(root,'bridge-testnet-walkthrough.mp4')]);
  console.log('Created narrated evidence walkthrough and transcript in '+root);
 },
 'check-package'(){
  if(!arg)throw new Error('usage: node scripts/release.mjs check-package PACK_JSON');
  const [pack]=readJson(arg);
  for(const {path:p} of pack.files){
   const parts=p.split('/');if(parts.some(x=>['.state','.tools','node_modules','output'].includes(x))||parts.at(-1)==='.env'||p.endsWith('secret.json'))throw new Error(`Private or generated local path in package: ${p}`);
  }
  for(const required of ['dist/src/sdk.js','dist/build/midnight/contract/index.js','LICENSE','docs/operations.md','examples/notes/env.example','examples/notes/index.html'])if(!pack.files.some(x=>x.path===required))throw new Error(`Missing ${required}`);
  console.log(`Package passed: ${pack.files.length} files, ${pack.size} bytes, ${pack.shasum}`);
 },
};
const SLIDE_PY=`from PIL import Image,ImageDraw,ImageFont
import sys
stem,title,body=sys.argv[1:]
im=Image.new('RGB',(1280,720),'#0d1727');d=ImageDraw.Draw(im)
font='/System/Library/Fonts/Supplemental/Arial.ttf'
h=ImageFont.truetype(font,42);b=ImageFont.truetype(font,30);small=ImageFont.truetype(font,22)
d.text((70,85),title,font=h,fill='#ffffff')
y=190
for line in body.split('\\n'):
 if d.textbbox((0,0),line,font=b)[2]>1140: raise ValueError('Slide line too long')
 d.text((70,y),line,font=b,fill='#dce7f5');y+=58
if y>620: raise ValueError('Slide too tall')
d.text((70,660),'Evidence: docs/evidence/testnet-transactions.json',font=small,fill='#97b4cc')
im.save(stem+'.png')`;
if(!commands[command])throw new Error(`usage: node scripts/release.mjs ${Object.keys(commands).join('|')}`);
commands[command]();
