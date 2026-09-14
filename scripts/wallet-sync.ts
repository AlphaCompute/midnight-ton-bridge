import {openMidnight} from '../src/live-midnight.js';
const client=await openMidnight({waitForFunds:!process.argv.includes('--initialize-only')});
try{console.log('Wallet address:',client.wallet.unshieldedKeystore.getBech32Address().asString());console.log(process.argv.includes('--initialize-only')?'Initialized checkpoint; not a funded/synchronized assertion':'Wallet synchronized and fee resources available');}finally{await client.close();}
