import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {Address,Cell} from '@ton/core';
import {verifyAsset,type JettonAsset} from '../src/jettons.js';
import {verifyEscrowPins,type EscrowPins} from '../src/escrow.js';
import {finalizedBlock} from '../src/ton-network.js';
import {openTon} from '../src/live-ton.js';
import {readState,statePath} from '../src/environment.js';
import {loadTonCode} from './lib/util.js';
const {client}=openTon(),plan=readState<{adapter:string;assets:(JettonAsset&EscrowPins)[]}>('ton-plan.json');
assert.equal(plan.adapter,'tep74-reference','only the reference-wallet route is supported');
const {head,block}=await finalizedBlock(client),escrowCode=loadTonCode('escrow-standard').hash().toString('hex'),results=[];
for(const a of plan.assets){
 assert.equal(a.codeHash,escrowCode,'plan escrow code differs from the compiled escrow');
 await verifyEscrowPins(client,block,a);await verifyAsset(client,a,Address.parse(a.escrow));
 for(const [role,address,codeHash] of [['minter',a.master,a.masterCodeHash],['escrow',a.escrow,a.codeHash]] as const){
  const r=await client.getAccount(block,Address.parse(address)),state=r.account.state;
  if(state.type!=='active'||!state.code)throw new Error(`${role} ${address} is not active`);
  const hash=Cell.fromBase64(state.code).hash().toString('hex');assert.equal(hash,codeHash);
  results.push({asset:a.asset,role,address,codeHash:hash,last:r.account.last});
 }
}
const at={...head.last,seqno:block};
writeFileSync(statePath('ton-deployment-verified.json'),JSON.stringify({network:'ton-testnet',block:at,results},null,2));console.log('Four public TON contracts active and escrow code hashes verified at block',block);
