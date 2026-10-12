import {openMidnight} from '../src/live-midnight.js';
import {flag} from './lib/util.js';

// Midnight wallet maintenance: `sync [--initialize-only]` or `reconcile TRANSACTION_ID`.
const [command,id]=process.argv.slice(2);
if(command==='sync'){
 const initializeOnly=flag('--initialize-only'),client=await openMidnight({waitForFunds:!initializeOnly});
 try{console.log('Wallet address:',client.wallet.unshieldedKeystore.getBech32Address().asString());console.log(initializeOnly?'Initialized checkpoint; not a funded/synchronized assertion':'Wallet synchronized and fee resources available');}finally{await client.close();}
}else if(command==='reconcile'){
 const wait=Number(process.env.RECONCILE_WAIT_MS??120000);if(!id)throw new Error('usage: npm run reconcile:midnight -- TRANSACTION_ID');
 if(!Number.isSafeInteger(wait)||wait<1000)throw new Error('RECONCILE_WAIT_MS must be at least 1000');
 const client=await openMidnight({waitForFunds:false});
 // Exit 2 while the exact transaction is still unknown; the journal entry stays pending.
 try{if(!client.journal.get(id))throw new Error('unknown journal entry');const result=await client.reconcile(id,wait);console.log(result);if(result.status==='pending')process.exitCode=2;}finally{await client.close();}
}else throw new Error('Commands: sync [--initialize-only], reconcile TRANSACTION_ID');
