import {referenceWallet,verifyAsset,type JettonAsset} from '../src/jettons.js';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {Address,Cell} from '@ton/core';
import {network,readState,statePath} from '../src/environment.js';
import {existsSync} from 'node:fs';
import {openIndexer} from '../src/midnight-indexer.js';
import {tonClient} from '../src/ton-network.js';
import {observeTonDeposit,type EscrowPins} from '../src/escrow.js';
import {verifyJettonDelivery} from '../src/ton-traces.js';
import {finalizedBlock,TON_FINALITY_DEPTH} from '../src/ton-network.js';
import {verifyRedemption,type MidnightPins} from '../src/redemptions.js';
import {ledger} from '../build/midnight/contract/index.js';
import {assertRoundTripLedger,rereadCalls} from './lib/round-trip.js';
if(network()!=='preprod')throw new Error('preprod required');
const e=readState('testnet-evidence.json'),d=readState<{address:string;domain:string;pins:MidnightPins}>('midnight-deployment.json');
const plan=readState<{adapter:string;domain:string;assets:(JettonAsset&EscrowPins)[]}>('ton-plan.json');
assert.equal(e.complete,true,'round trip has not completed');assert.equal(e.midnight,d.address);assert.equal(d.domain,plan.domain);assert.equal(plan.adapter,'tep74-reference');
// Read-only: the demo wallet's public address comes from funding.json, never its secret.
const provider=openIndexer('preprod'),ton={client:tonClient()},tonWallet=Address.parse(readState<{ton:string}>('funding.json').ton);
const steps=e.steps.filter((x:{circuit?:string})=>x.circuit),calls=await rereadCalls(provider,steps);
// The published evidence records each call's finalized block hash.
calls.forEach((c,i)=>{steps[i].blockHash=c.blockHash;});
const state=await provider.queryContractState(d.address,{type:'blockHash',blockHash:calls.at(-1)!.blockHash});assert(state);
assert.equal(state.maintenanceAuthority.committee.length,0);assert.equal(state.maintenanceAuthority.threshold,1);
const data=ledger(state.data);assertRoundTripLedger(data);
const [retired]=[...data.retired],id=Buffer.from(retired![0]).toString('hex');verifyRedemption(state,d.pins,{id,asset:0,amount:'100',recipient:tonWallet.toRawString(),transactionId:calls.at(-1)!.txId},[plan.assets[0]!.escrow,plan.assets[1]!.escrow]);
for(const a of plan.assets){
 const escrow=Address.parse(a.escrow),expected=a.asset===0?9900n:10000n;
 await verifyAsset(ton.client,a,escrow);
 const receipt=await observeTonDeposit(ton.client,{...a,confirmationDepth:TON_FINALITY_DEPTH},0n),prior=e.steps.find((x:any)=>x.deposit?.asset===a.asset).deposit;
 assert.equal(receipt.id,prior.id);assert.equal(receipt.amount,'10000');assert.equal(receipt.recipient,prior.recipient);
 const {block}=await finalizedBlock(ton.client);
 assert.equal((await ton.client.runMethod(block,escrow,'locked')).reader.readBigNumber(),expected);
 assert.equal((await ton.client.runMethod(block,referenceWallet(escrow,Address.parse(a.master),Cell.fromBase64(a.walletCodeBoc)).address,'get_wallet_data')).reader.readBigNumber(),expected);
}
e.delivery=await verifyJettonDelivery(ton.client,Address.parse(e.delivery.from),Address.parse(e.delivery.to),BigInt(e.delivery.queryId),100n);
e.independentReadback={verifiedAt:new Date().toISOString(),pins:d.pins,immutable:true,collateralMatchesCirculation:true,allSixCallsFinalized:true};
writeFileSync('docs/evidence/testnet-transactions.json',JSON.stringify(e,null,2)+'\n');
writeFileSync('docs/evidence/testnet-deployment.json',JSON.stringify({network:'TON-testnet/Midnight-preprod',domain:d.domain,midnight:d.address,pins:d.pins,ton:plan.assets,tonVerification:readState('ton-deployment-verified.json'),custody:'single development host; synthetic assets only'},null,2)+'\n');
writeFileSync('docs/evidence/testnet-assets.json',JSON.stringify(plan.assets.map(({asset,symbol,decimals,master,masterCodeHash,walletCodeBoc,walletCodeHash,cap,adapter})=>({asset,symbol,decimals,master,masterCodeHash,walletCodeBoc,walletCodeHash,cap,adapter})),null,2)+'\n');
// The live unrecorded-credit recovery (demo:unrecorded), when completed on this route.
if(existsSync(statePath('unrecorded-evidence.json'))){
 const r=readState<any>('unrecorded-evidence.json');assert.equal(r.complete,true,'recovery demonstration has not completed');assert.equal(Address.parse(r.escrow).toRawString(),Address.parse(plan.assets[0]!.escrow).toRawString());
 r.delivery=await verifyJettonDelivery(ton.client,Address.parse(r.delivery.from),Address.parse(r.delivery.to),BigInt(r.delivery.queryId),BigInt(r.amount));
 writeFileSync('docs/evidence/testnet-recovery.json',JSON.stringify(r,null,2)+'\n');
}
console.log('Public testnet independently re-read: six calls finalized, recipient paid, collateral and circulation match.');
