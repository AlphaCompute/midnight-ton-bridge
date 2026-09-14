import {network,statePath,stateDirectory} from '../src/environment.js';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {newSigningKey,verifyingKey} from '../src/midnight.js';
import {statePins} from '../src/redemptions.js';
import {openMidnight} from '../src/live-midnight.js';
stateDirectory();
const destination=statePath('midnight-deployment.json');
if(existsSync(destination))throw new Error('Deployment record exists; do not duplicate an existing deployment');
const committeeFile=process.env.MIDNIGHT_COMMITTEE_FILE;
if(!committeeFile&&network()!=='local')throw new Error('Preprod requires MIDNIGHT_COMMITTEE_FILE with three independently held public keys');
let committee:ReturnType<typeof verifyingKey>[];
if(committeeFile){committee=(JSON.parse(readFileSync(committeeFile,'utf8')) as {x:string;y:string}[]).map(p=>({x:BigInt(p.x),y:BigInt(p.y)}));}
else{
 const keyPath=statePath('test-committee.json');
 if(!existsSync(keyPath))writeFileSync(keyPath,JSON.stringify([newSigningKey(),newSigningKey(),newSigningKey()].map(String)),{mode:0o600,flag:'wx'});
 committee=(JSON.parse(readFileSync(keyPath,'utf8')) as string[]).map(s=>verifyingKey(BigInt(s)));
}
if(committee.length!==3)throw new Error('three committee keys required');
const intentPath=statePath('midnight-deployment-intent.json');
if(existsSync(intentPath))throw new Error('Deployment intent exists; reconcile the transaction journal before retrying. Do not create a second deployment blindly.');
const domain=process.env.BRIDGE_DOMAIN?Buffer.from(process.env.BRIDGE_DOMAIN,'hex'):randomBytes(32);
if(domain.length!==32)throw new Error('invalid bridge domain');
writeFileSync(intentPath,JSON.stringify({domain:domain.toString('hex'),network:network(),started:new Date().toISOString()}),{mode:0o600,flag:'wx'});
const client=await openMidnight();
try{
 const deployed=await client.deploy(domain,committee,1_000_000_000_000n);
 const state=await client.providers.publicDataProvider.queryContractState(deployed.deployTxData.public.contractAddress);if(!state)throw new Error('deployed state absent');
 writeFileSync(destination,JSON.stringify({pins:statePins(state),network:client.env.networkId,address:deployed.deployTxData.public.contractAddress,domain:domain.toString('hex'),committee:committee},(_,v)=>typeof v==='bigint'?v.toString():v,2),{mode:0o600,flag:'wx'});
 console.log(`Deployment recorded in ${destination}`);
}finally{await client.close();}
