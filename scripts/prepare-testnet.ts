import {WalletSeeds} from '@midnight-ntwrk/testkit-js';
import {createKeystore} from '@midnight-ntwrk/wallet-sdk';
import {existsSync,writeFileSync,readFileSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {WalletContractV4} from '@ton/ton';
import {keyPairFromSeed,mnemonicNew,mnemonicToPrivateKey} from '@ton/crypto';
import {statePath,network,readSecret} from '../src/environment.js';
import {newSigningKey,verifyingKey} from '../src/midnight.js';
if(network()!=='preprod')throw new Error('Set BRIDGE_NETWORK=preprod; this only prepares fresh testnet identities');
if(!existsSync(statePath('ton-test-wallet.json'))){
 const words=await mnemonicNew(),pair=await mnemonicToPrivateKey(words);
 writeFileSync(statePath('acton-mnemonic.txt'),words.join(' '),{mode:0o600,flag:'wx'});
 writeFileSync(statePath('ton-test-wallet.json'),JSON.stringify({seed:pair.secretKey.subarray(0,32).toString('hex')}),{mode:0o600,flag:'wx'});
}
if(existsSync(statePath('acton-mnemonic.txt'))){
 writeFileSync(statePath('Acton.toml'),'[package]\nname = "bridge-testnet"\ndescription = "Testnet faucet wallet"\nversion = "0.1.0"\nlicense = "Apache-2.0"\n');
 writeFileSync(statePath('wallets.toml'),'[wallets.bridge]\nkind="v4r2"\nworkchain=0\nkeys={mnemonic-file='+JSON.stringify(statePath('acton-mnemonic.txt'))+'}\n',{mode:0o600});
}
for(const name of ['midnight-test-wallet.json'])if(!existsSync(statePath(name))){
 writeFileSync(statePath(name),JSON.stringify({seed:randomBytes(32).toString('hex')}),{mode:0o600,flag:'wx'});
 writeFileSync(statePath('fresh-wallet.json'),JSON.stringify({createdAt:new Date().toISOString(),purpose:'new unused synthetic test wallet'}),{mode:0o600,flag:'wx'});
}
const seed=readSecret<{seed:string}>(statePath('ton-test-wallet.json')).seed;
const wallet=WalletContractV4.create({workchain:0,publicKey:keyPairFromSeed(Buffer.from(seed,'hex')).publicKey});
if(!existsSync(statePath('faucet-device.json')))writeFileSync(statePath('faucet-device.json'),JSON.stringify({id:randomUUID()}),{mode:0o600,flag:'wx'});
// Centrally held keys are explicitly a public-testnet demonstration, never independent operators.
if(!existsSync(statePath('demo-operators.json')))writeFileSync(statePath('demo-operators.json'),JSON.stringify([0,1,2].map(()=>({tonSeed:randomBytes(32).toString('hex'),midnight:newSigningKey().toString()}))),{mode:0o600,flag:'wx'});
const operators=readSecret<{tonSeed:string;midnight:string}[]>(statePath('demo-operators.json'));
writeFileSync(statePath('midnight-public-committee.json'),JSON.stringify(operators.map(x=>verifyingKey(BigInt(x.midnight))),(_,v)=>typeof v==='bigint'?v.toString():v,2));
writeFileSync(statePath('ton-public-committee.json'),JSON.stringify(operators.map(x=>keyPairFromSeed(Buffer.from(x.tonSeed,'hex')).publicKey.toString('hex')),null,2));
const midnight=createKeystore(WalletSeeds.fromMasterSeed(readSecret<{seed:string}>(statePath('midnight-test-wallet.json')).seed).unshielded,'preprod').getBech32Address().asString();
writeFileSync(statePath('funding.json'),JSON.stringify({...existsSync(statePath('funding.json'))?JSON.parse(readFileSync(statePath('funding.json'),'utf8')):{},network:'preprod',midnight,ton:wallet.address.toString({testOnly:true,bounceable:false}),committeeCustody:'single development host; synthetic testnet only'},null,2));
console.log('TON testnet funding address:',wallet.address.toString({testOnly:true,bounceable:false}));

console.log('Midnight preprod funding address:',midnight);
