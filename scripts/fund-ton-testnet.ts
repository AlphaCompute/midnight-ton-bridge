import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {network,stateDirectory} from '../src/environment.js';
if(network()!=='preprod')throw new Error('testnet faucet only');
const binary=resolve(process.env.ACTON_BINARY??'.tools/acton/acton');
const result=spawnSync(binary,['wallet','airdrop','bridge','--net','testnet','--no-wait-airdrop'],{cwd:stateDirectory(),stdio:'inherit'});
if(result.error)throw result.error;if(result.status!==0)throw new Error('Official Acton faucet request failed');
console.log('Queue acknowledgment only. Verify the wallet balance before sending.');
