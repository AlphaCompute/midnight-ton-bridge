import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {Address} from '@ton/core';
import {DatabaseSync} from 'node:sqlite';
import {ledger} from '../build/midnight/contract/index.js';
import {network,readState,statePath} from '../src/environment.js';
import {openIndexer} from '../src/midnight-indexer.js';
import {statePins} from '../src/redemptions.js';
import {verifyAsset,validateAssets} from '../src/jettons.js';
import {verifyEscrowPins,type EscrowPins} from '../src/escrow.js';
import {PENDING_STAGES} from '../src/journal.js';
import {tonClient} from '../src/ton-network.js';

// Read-only route accounting check (also the monitor's probe): pins, backing versus
// circulation and unresolved journals. Opens no wallet and reads no secrets.
if(network()!=='preprod')throw new Error('preprod required');
const plan=readState<{domain:string;adapter:string;assets:EscrowPins[]}>('ton-plan.json'),deployment=readState('midnight-deployment.json');
assert.equal(plan.domain,deployment.domain);assert.equal(plan.adapter,'tep74-reference');const assets=validateAssets(plan.assets);
const state=await openIndexer('preprod').queryContractState(deployment.address);assert(state);assert.deepEqual(statePins(state),deployment.pins);assert.equal(state.maintenanceAuthority.committee.length,0);assert.equal(state.maintenanceAuthority.threshold,1);
const data=ledger(state.data),client=tonClient(),rows=[],issues:string[]=[];
for(const a of assets){
 const route=plan.assets[a.asset]!,escrow=Address.parse(route.escrow),verified=await verifyAsset(client,a,escrow);
 const {cap}=await verifyEscrowPins(client,verified.block,route);
 if(cap>data.cap)issues.push(`Asset ${a.asset}: escrow cap ${cap} exceeds Midnight cap ${data.cap}; deposits could become unclaimable`);
 const locked=(await client.runMethod(verified.block,escrow,'locked')).reader.readBigNumber();
 const balance=(await client.runMethod(verified.block,Address.parse(verified.wallet),'get_wallet_data')).reader.readBigNumber();
 const circulating=data.circulating[a.asset];if(balance!==locked||locked!==circulating)issues.push(`Asset ${a.asset}: accounting is unsettled or inconsistent; inspect deposits, refunds and pending releases`);
 rows.push({asset:a.asset,master:a.master,block:verified.block,balance:String(balance),locked:String(locked),circulating:String(circulating)});
}
// Journals are opened read-only: the monitor must never create or chmod live state.
const pending=`SELECT COUNT(*) AS n FROM transfers WHERE stage IN (${PENDING_STAGES.map(s=>`'${s}'`).join(',')})`;
for(const name of ['ton-transactions.sqlite','midnight-transactions.sqlite']){const db=new DatabaseSync(statePath(name),{readOnly:true});try{const row=db.prepare(pending).get() as {n:number};if(row.n)issues.push(`${name}: ${row.n} unreconciled transaction(s)`);}finally{db.close();}}
const report={network:'TON-testnet/Midnight-preprod',checkedAt:new Date().toISOString(),midnight:deployment.address,assets:rows,issues,settled:issues.length===0,note:'Independent chain snapshots; run after transfers settle. Equality is necessary but is not proof of every transfer or an audit.'};
console.log(JSON.stringify(report,null,2));
if(issues.length)process.exitCode=1;
// --publish records a settled check as the route's accounting evidence.
else if(process.argv.includes('--publish'))writeFileSync('docs/evidence/testnet-accounting.json',JSON.stringify(report,null,2)+'\n');
