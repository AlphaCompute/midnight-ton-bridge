import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {Address,Cell} from '@ton/core';
import WebSocket from 'ws';
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id';
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {ledger} from '../build/midnight/contract/index.js';
import {TonClient4} from '@ton/ton';
import {DatabaseSync} from 'node:sqlite';
import {network,statePath} from '../src/environment.js';
import {midnightIndexer} from '../src/midnight-endpoints.js';
import {statePins} from '../src/redemptions.js';
import {verifyAsset,validateAssets} from '../src/jettons.js';
if(network()!=='preprod')throw new Error('preprod required');
const read=(p:string)=>JSON.parse(readFileSync(statePath(p),'utf8')),plan=read('ton-plan.json'),deployment=read('midnight-deployment.json');
assert.equal(plan.domain,deployment.domain);assert.equal(plan.adapter,'tep74-reference');const assets=validateAssets(plan.assets);
setNetworkId('preprod');globalThis.WebSocket=WebSocket as unknown as typeof globalThis.WebSocket;
const endpoints=midnightIndexer('preprod'),provider=indexerPublicDataProvider(endpoints.indexer,endpoints.indexerWS);
const state=await provider.queryContractState(deployment.address);assert(state);assert.deepEqual(statePins(state),deployment.pins);assert.equal(state.maintenanceAuthority.committee.length,0);assert.equal(state.maintenanceAuthority.threshold,1);
const data=ledger(state.data),t={client:new TonClient4({endpoint:process.env.TON_RPC_URL??'https://testnet-v4.tonhubapi.com'})},rows=[],issues:string[]=[];
for(const a of assets){
 const route=plan.assets[a.asset],escrow=Address.parse(route.escrow),verified=await verifyAsset(t.client,a,escrow);
 const account=(await t.client.getAccount(verified.block,escrow)).account.state;
 assert(account.type==='active'&&account.code&&account.data);assert.equal(Cell.fromBase64(account.code).hash().toString('hex'),route.codeHash);assert.equal(Cell.fromBase64(account.data).beginParse().loadRef().hash().toString('hex'),route.configHash);
 const config=Cell.fromBase64(account.data).beginParse().loadRef().beginParse();config.skip(256);config.loadRef();config.loadAddress();config.loadRef();
 const escrowCap=config.loadUintBig(64);if(escrowCap>data.cap)issues.push(`Asset ${a.asset}: escrow cap ${escrowCap} exceeds Midnight cap ${data.cap}; deposits could become unclaimable`);
 const locked=(await t.client.runMethod(verified.block,escrow,'locked')).reader.readBigNumber();
 const balance=(await t.client.runMethod(verified.block,Address.parse(verified.wallet),'get_wallet_data')).reader.readBigNumber();
 const circulating=data.circulating[a.asset];if(balance!==locked||locked!==circulating)issues.push(`Asset ${a.asset}: accounting is unsettled or inconsistent; inspect deposits, refunds and pending releases`);
 rows.push({asset:a.asset,master:a.master,block:verified.block,balance:String(balance),locked:String(locked),circulating:String(circulating)});
}
for(const name of ['ton-transactions.sqlite','midnight-transactions.sqlite']){const db=new DatabaseSync(statePath(name),{readOnly:true});try{const row=db.prepare("SELECT COUNT(*) AS n FROM transfers WHERE stage != 'confirmed'").get() as {n:number};if(row.n)issues.push(`${name}: ${row.n} unreconciled transaction(s)`);}finally{db.close();}}
console.log(JSON.stringify({network:'TON-testnet/Midnight-preprod',checkedAt:new Date().toISOString(),midnight:deployment.address,assets:rows,issues,settled:issues.length===0,note:'Independent chain snapshots; run after transfers settle. Equality is necessary but is not proof of every transfer or an audit.'},null,2));
if(issues.length)process.exitCode=1;
