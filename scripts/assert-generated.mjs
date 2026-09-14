import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const hash=createHash('sha256').update(readFileSync('contracts/midnight/bridge.compact')).digest('hex');
let fingerprint='';try{fingerprint=readFileSync('build/midnight/.source-fingerprint','utf8');}catch{}
if(!fingerprint.startsWith(hash+'-'))throw new Error('Missing or stale Compact bindings. Run npm run compile:midnight before build/test.');
