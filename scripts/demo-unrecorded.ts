import {writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {Address,Cell,beginCell,internal,toNano,type Transaction} from '@ton/core';
import {keyPairFromSeed} from '@ton/crypto';
import {network,statePath,readSecret,readState} from '../src/environment.js';
import {toJson} from '../src/encoding.js';
import {openTon} from '../src/live-ton.js';
import {referenceWallet,unrecordedDigest,unrecordedBody,type JettonAsset} from '../src/jettons.js';
import {messageHash,observeUnrecordedCredit,txLocator,verifyJettonDelivery} from '../src/ton-traces.js';
import {OP,refundBody,signTonDigest} from '../src/ton.js';
import {TON_FINALITY_DEPTH} from '../src/ton-network.js';
import {waitFor} from './lib/util.js';

// Live check of the unrecorded-credit recovery path: an underfunded deposit strands on
// chain, two committee members attest the exact trace, and the sender is refunded.
if(network()!=='preprod')throw new Error('Public testnets only');
const plan=readState('ton-plan.json');
if(plan.adapter!=='tep74-reference')throw new Error('Standard adapter route required');
const evidencePath=statePath('unrecorded-evidence.json');if(existsSync(evidencePath))throw new Error('Prior recovery attempt exists; reconcile it instead of rerunning');
const ops=readSecret<{tonSeed:string}[]>(statePath('demo-operators.json'));
const t=openTon(),a=plan.assets[0] as JettonAsset&{escrow:string},escrow=Address.parse(a.escrow),master=Address.parse(a.master),code=Cell.fromBase64(a.walletCodeBoc);
const userWallet=referenceWallet(t.wallet.address,master,code).address,escrowWallet=referenceWallet(escrow,master,code).address,amount=50n;
const evidence:Record<string,unknown>={network:'TON-testnet',escrow:escrow.toRawString(),amount:amount.toString(),steps:[]};
const save=()=>writeFileSync(evidencePath,toJson(evidence));
const steps=evidence.steps as unknown[];
const wait=<T>(fn:()=>Promise<T>)=>waitFor(fn,{timeoutMs:300000,intervalMs:5000});
const head=async()=>(await t.client.getLastBlock()).last.seqno-TON_FINALITY_DEPTH;
const get=async(address:Address,method:string,args:{type:'int';value:bigint}[]=[])=>{const r=await t.client.runMethod(await head(),address,method,args);if(r.exitCode!==0)throw new Error(`${method} failed`);return r.reader;};
const history=async(address:Address)=>{const s=await t.client.getAccountLite(await head(),address);if(!s.account.last)return [] as Transaction[];return (await t.client.getAccountTransactions(address,BigInt(s.account.last.lt),Buffer.from(s.account.last.hash,'base64'))).map(r=>r.tx);};

const before={locked:(await get(escrow,'locked')).readBigNumber(),refunds:(await get(escrow,'refundCount')).readNumber(),balance:(await get(escrowWallet,'get_wallet_data')).readBigNumber()};
evidence.before=before;save();
// 1 nanoton forward: the escrow cannot run, so the credit is recorded nowhere.
const query=BigInt(Date.now());
const body=beginCell().storeUint(OP.jettonTransfer,32).storeUint(query,64).storeCoins(amount).storeAddress(escrow).storeAddress(t.wallet.address).storeBit(false).storeCoins(1n).storeBit(false).storeBuffer(Buffer.alloc(32,9)).endCell();
steps.push(await t.send(`demo-unrecorded-deposit:${plan.domain}`,[internal({to:userWallet,value:toNano('0.1'),body})]));save();
const credit=await wait(async()=>{const tx=(await history(escrowWallet)).find(x=>{const m=x.inMessage;if(!m||m.info.type!=='internal')return false;const s=m.body.beginParse();return s.remainingBits>=96&&s.loadUint(32)===OP.internalTransfer&&s.loadUintBig(64)===query;});assert(tx,'credit not final yet');return tx;});
const notice=[...credit.outMessages.values()].find(m=>m.info.type==='internal'&&m.info.dest.equals(escrow));assert(notice,'notification missing');
const handled=await wait(async()=>{const tx=(await history(escrow)).find(x=>x.inMessage&&messageHash(x.inMessage).equals(messageHash(notice)));assert(tx,'escrow transaction not final yet');return tx;});
assert.equal((await get(escrow,'locked')).readBigNumber(),before.locked);assert.equal((await get(escrow,'refundCount')).readNumber(),before.refunds);
evidence.stranded={creditTx:credit.hash().toString('hex'),escrowTx:handled.hash().toString('hex'),compute:handled.description.type==='generic'?handled.description.computePhase.type:'other'};save();

// Two independent committee observations of the exact trace, then one relayed quorum.
const seen=await observeUnrecordedCredit(t.client,a,escrow,{credit:txLocator(credit),notification:txLocator(handled)});
assert.equal(seen.amount,amount);assert(seen.from.equals(t.wallet.address));
const digest=unrecordedDigest(escrow,Buffer.from(plan.domain,'hex'),seen.evidence,seen.amount,seen.from);
const sig=(i:number)=>signTonDigest(digest,keyPairFromSeed(Buffer.from(ops[i]!.tonSeed,'hex')).secretKey);
steps.push(await t.send(`demo-unrecorded-attest:${seen.evidence.toString('hex')}`,[internal({to:escrow,value:toNano('0.2'),body:unrecordedBody(seen.evidence,seen.amount,seen.from,0,2,sig(0),sig(2))})]));save();
await wait(async()=>assert.equal((await get(escrow,'refundCount')).readNumber(),before.refunds+1));
const record=(await get(escrow,'refund',[{type:'int',value:BigInt(before.refunds)}])).readCell().beginParse();
assert.equal(record.loadUintBig(64),amount);assert(record.loadAddress().equals(t.wallet.address));
assert.equal((await get(escrow,'recovered',[{type:'int',value:BigInt('0x'+seen.evidence.toString('hex'))}])).readNumber(),1);

// Anyone may pay the recorded refund; only the original sender receives it.
const q=(await get(escrow,'nextRelease')).readBigNumber();
steps.push(await t.send(`demo-unrecorded-refund:${before.refunds}`,[internal({to:escrow,value:toNano('0.2'),body:refundBody(BigInt(before.refunds))})]));save();
evidence.delivery=await wait(()=>verifyJettonDelivery(t.client,escrowWallet,userWallet,q,amount));
const after={locked:(await get(escrow,'locked')).readBigNumber(),balance:(await get(escrowWallet,'get_wallet_data')).readBigNumber()};
assert.equal(after.locked,before.locked);assert.equal(after.balance,before.balance);
evidence.after=after;evidence.complete=true;save();
console.log('Underfunded deposit stranded, recovered by quorum and refunded to its sender. Evidence:',evidencePath);
