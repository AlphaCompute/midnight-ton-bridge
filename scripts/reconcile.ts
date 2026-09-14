import {openMidnight} from '../src/live-midnight.js';
const id=process.argv[2];if(!id)throw new Error('usage: npm run reconcile -- TRANSACTION_ID');
const client=await openMidnight({waitForFunds:false});
try{if(!client.journal.get(id))throw new Error('unknown journal entry');console.log(await client.reconcile(id));}finally{await client.close();}
