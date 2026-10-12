import {openMidnight} from '../src/live-midnight.js';
const id=process.argv[2],wait=Number(process.env.RECONCILE_WAIT_MS??120000);if(!id)throw new Error('usage: npm run reconcile -- TRANSACTION_ID');
if(!Number.isSafeInteger(wait)||wait<1000)throw new Error('RECONCILE_WAIT_MS must be at least 1000');
const client=await openMidnight({waitForFunds:false});
try{if(!client.journal.get(id))throw new Error('unknown journal entry');const result=await client.reconcile(id,wait);console.log(result);if(result.status==='pending')process.exitCode=2;}finally{await client.close();}
