// macOS narration/render helper. Reviews existing finalized evidence; does not
// fabricate a live screen capture or broadcast new bridge transactions.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const e=JSON.parse(readFileSync('docs/standard-testnet-evidence.json')),d=JSON.parse(readFileSync('docs/standard-testnet-deployment.json')),b=JSON.parse(readFileSync('docs/benchmarks.json'));
if(!e.complete||!e.independentReadback?.allSixCallsFinalized)throw Error('Verified completed evidence required');
const root=resolve('output/demo');mkdirSync(root,{recursive:true});
const chapters=[
 ['Midnight - TON bridge','Finalized testnet evidence walkthrough\nTON testnet + Midnight preprod\nAI-narrated review; not a new transaction recording', 'This is a narrated walkthrough of the completed Midnight TON bridge testnet demonstration. It reviews finalized transaction evidence, rather than broadcasting a fresh transaction or pretending to be a live screen recording. The network tokens are valueless and are not issuer approved WHIS or USD1.'],
 ['Two-chain bridge deployment',`Midnight: ${d.midnight.slice(0,28)}...\nTwo allowlisted TON jetton masters and escrows\nUnmodified TON reference wallets\nFixed two-of-three committee`, 'The bridge uses two allowlisted TON jetton escrows and a Midnight contract for representations, retirement and a two asset pool. The current route uses the unmodified TON reference wallet. Existing compatible masters can be configured without issuer mint authority. The testnet demonstration committee is held on one development host; production requires independent custody.'],
 ['Deposit and claim','10,000 base units deposited for each asset\nAuthenticated TON escrow receipts\nTwo finalized Midnight claims\nQuorum signatures bind route, amount and recipient', 'The recorded demonstration deposits ten thousand base units of each token into TON escrow. Each authenticated receipt is checked before the corresponding Midnight representation is claimed. The authorization binds the route, amount, asset and recipient. Both claims finalized successfully. Replay and altered authorization are rejected in the automated contract tests.'],
 ['Liquidity and swap','Add liquidity: 5,000 / 5,000 base units\nSwap: 100 units, bounded minimum output\nWithdraw all liquidity\nFinal pool reserves and shares: zero', 'Both assets are supplied to the Midnight pool. The demonstration adds five thousand units of each, swaps one hundred units, and withdraws all liquidity. The contract checks the reserve ratio, rounding, authorization and slippage. Pool reserves and liquidity shares return to zero. Bridge backing is separate from liquidity pool capital.'],
 ['Redemption and recipient delivery','Retire 100 units on Midnight\nRelease 100 units on TON\nSource and recipient message hashes match\nFinal backing = circulation: 9,900 / 10,000', 'The next step permanently retires one hundred representations on Midnight. Two signatures authorize their return on TON. Verification follows the matching outgoing and incoming message hashes and confirms successful recipient credit. Wallet submission alone is not treated as delivery. The final backing and circulating supply match at nine thousand nine hundred and ten thousand units.'],
 ['Recovery and operational checks',`14 automated tests in the current release\nExact downstream-bounce recovery\nDurable transaction and signer journals\nMonitor health, metrics and failure alerts\nMeasured median call: ${(b.summary.medianMilliseconds/1000).toFixed(2)} seconds`, 'Tests cover actual downstream failure and successful retry, forged evidence, replay, refunds, cryptographic constraints and accounting. Recovery restores only the exact pending instruction after independently observed failure. Transaction journals prevent blind replacement sends. The monitoring service exposes health and metrics, detects stale checks and retains failure state across restarts. The six measured calls have a median total call duration of about twenty two seconds. This is not a throughput benchmark or a service guarantee.'],
 ['Handoff and release boundaries','README: setup, testnet deployment and operations\nSDK, source, evidence and checksums\nMainnet broadcast remains disabled\nStill external: issuer approval, independent review,\ncustody and Foundation acceptance', 'The handoff includes the source, SDK, testnet evidence and checksums. The README explains deployment and operations. Mainnet broadcast remains disabled until approved production assets, independent security review and operator custody are resolved. This implementing agent review is not an independent audit, and neither the software nor this recording substitutes for written Foundation acceptance.']
];
writeFileSync(resolve(root,'transcript.txt'),chapters.map(([title,,n])=>title+'\n'+n).join('\n\n'));
const outputs=[];
for(const [i,[title,body,narration]]of chapters.entries()){
 const stem=resolve(root,`chapter-${i}`);writeFileSync(stem+'.txt',title+'\n\n'+body+'\n\nEvidence: docs/standard-testnet-evidence.json');writeFileSync(stem+'-voice.txt',narration);
 execFileSync('say',['-v','Samantha','-r','165','-f',stem+'-voice.txt','-o',stem+'.aiff']);
 execFileSync(process.env.BRIDGE_PYTHON??'python3',['-c',`from PIL import Image,ImageDraw,ImageFont
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
d.text((70,660),'Evidence: docs/standard-testnet-evidence.json',font=small,fill='#97b4cc')
im.save(stem+'.png')`,stem,title,body]);
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-loop','1','-i',stem+'.png','-i',stem+'.aiff','-r','15','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-shortest',stem+'.mp4']);outputs.push(stem+'.mp4');
}
const list=resolve(root,'concat.txt');writeFileSync(list,outputs.map(p=>`file '${p}'`).join('\n'));
execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',resolve(root,'bridge-testnet-walkthrough.mp4')]);
console.log('Created narrated evidence walkthrough and transcript in '+root);
