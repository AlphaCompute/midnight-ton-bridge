import {existsSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {Address,Cell,beginCell,internal,toNano,type Transaction} from '@ton/core';
import {keyPairFromSeed} from '@ton/crypto';
import {network,statePath,readJson,readSecret,readState} from '../src/environment.js';
import {toJson} from '../src/encoding.js';
import {openTon} from '../src/live-ton.js';
import {Journal} from '../src/journal.js';
import {referenceWallet,unrecordedDigest,unrecordedBody,type JettonAsset} from '../src/jettons.js';
import {messageHash,observeUnrecordedCredit,recentTransactions,txLocator,verifyJettonDelivery} from '../src/ton-traces.js';
import {OP,refundBody,signTonDigest} from '../src/ton.js';
import {finalizedBlock} from '../src/ton-network.js';
import {flag,waitFor} from './lib/util.js';
import {evidenceSteps} from './lib/steps.js';

// Live check of the unrecorded-credit recovery path: an underfunded deposit strands on
// chain, two committee members attest the exact trace, and the sender is refunded.
// Resumable: after reconcile:ton, rerun with --resume to finish without repeating a step.
if(network()!=='preprod')throw new Error('Public testnets only');
const plan=readState<{adapter:string;domain:string;assets:(JettonAsset&{escrow:string})[]}>('ton-plan.json');
if(plan.adapter!=='tep74-reference')throw new Error('Standard adapter route required');
const evidencePath=statePath('unrecorded-evidence.json'),resume=flag('--resume');
if(existsSync(evidencePath)&&!resume)throw new Error('Prior recovery attempt exists; run reconcile:ton, then continue it with --resume');
if(!existsSync(evidencePath)&&resume)throw new Error('No prior attempt to resume');
const ops=readSecret<{tonSeed:string}[]>(statePath('demo-operators.json'));
const t=openTon(),a=plan.assets[0]!,escrow=Address.parse(a.escrow),master=Address.parse(a.master),code=Cell.fromBase64(a.walletCodeBoc);
const userWallet=referenceWallet(t.wallet.address,master,code).address,escrowWallet=referenceWallet(escrow,master,code).address,amount=50n;
const evidence:any=resume?readJson(evidencePath):{network:'TON-testnet',escrow:escrow.toRawString(),amount:amount.toString(),steps:[]};
if(evidence.complete)throw new Error('Recovery demonstration already complete');
const save=()=>writeFileSync(evidencePath,toJson(evidence));
const tonJournal=new Journal(statePath('ton-transactions.sqlite'));
const {once,tonOnce}=evidenceSteps(evidence,save,tonJournal,(id,messages)=>t.send(id,messages));
const wait=<T>(fn:()=>Promise<T>)=>waitFor(fn,{timeoutMs:300000,intervalMs:5000});
const get=async(address:Address,method:string,args:{type:'int';value:bigint}[]=[])=>{const {block}=await finalizedBlock(t.client);const r=await t.client.runMethod(block,address,method,args);if(r.exitCode!==0)throw new Error(`${method} failed`);return r.reader;};
const find=(address:Address,match:(tx:Transaction)=>boolean,what:string)=>wait(async()=>{const {block}=await finalizedBlock(t.client);const tx=(await recentTransactions(t.client,block,address)).find(match);assert(tx,`${what} not final yet`);return tx;});
try{
 const before=await once('before',async()=>({locked:String((await get(escrow,'locked')).readBigNumber()),refunds:(await get(escrow,'refundCount')).readNumber(),balance:String((await get(escrowWallet,'get_wallet_data')).readBigNumber()),query:String(Date.now())})) as any;
 const query=BigInt(before.query);
 // 1 nanoton forward: the escrow cannot run, so the credit is recorded nowhere.
 const body=beginCell().storeUint(OP.jettonTransfer,32).storeUint(query,64).storeCoins(amount).storeAddress(escrow).storeAddress(t.wallet.address).storeBit(false).storeCoins(1n).storeBit(false).storeBuffer(Buffer.alloc(32,9)).endCell();
 await tonOnce(`demo-unrecorded-deposit:${plan.domain}`,[internal({to:userWallet,value:toNano('0.1'),body})]);
 const credit=await find(escrowWallet,x=>{const m=x.inMessage;if(!m||m.info.type!=='internal')return false;const s=m.body.beginParse();return s.remainingBits>=96&&s.loadUint(32)===OP.internalTransfer&&s.loadUintBig(64)===query;},'credit');
 const notice=[...credit.outMessages.values()].find(m=>m.info.type==='internal'&&m.info.dest.equals(escrow)&&m.body.beginParse().preloadUint(32)===OP.transferNotification);assert(notice,'notification missing');
 const handled=await find(escrow,x=>!!x.inMessage&&messageHash(x.inMessage).equals(messageHash(notice)),'escrow transaction');
 await once('stranded',async()=>{
  assert.equal(String((await get(escrow,'locked')).readBigNumber()),before.locked);
  return {creditTx:credit.hash().toString('hex'),escrowTx:handled.hash().toString('hex'),compute:handled.description.type==='generic'?handled.description.computePhase.type:'other'};
 });

 // Two independent committee observations of the exact trace, then one relayed quorum.
 const seen=await observeUnrecordedCredit(t.client,a,escrow,{credit:txLocator(credit),notification:txLocator(handled)});
 assert.equal(seen.amount,amount);assert(seen.from.equals(t.wallet.address));
 const digest=unrecordedDigest(escrow,Buffer.from(plan.domain,'hex'),seen.evidence,seen.amount,seen.from);
 const sig=(i:number)=>signTonDigest(digest,keyPairFromSeed(Buffer.from(ops[i]!.tonSeed,'hex')).secretKey);
 await tonOnce(`demo-unrecorded-attest:${seen.evidence.toString('hex')}`,[internal({to:escrow,value:toNano('0.2'),body:unrecordedBody(seen.evidence,seen.amount,seen.from,0,2,sig(0),sig(2))})]);
 await wait(async()=>assert.equal((await get(escrow,'recovered',[{type:'int',value:BigInt('0x'+seen.evidence.toString('hex'))}])).readNumber(),1));
 const refundId=before.refunds as number;

 // Anyone may pay the recorded refund; only the original sender receives it. Its outgoing
 // query is recorded before sending so a resumed run verifies the right transfer.
 const {query:refundQuery}=await once('refund',async()=>{
  const record=(await get(escrow,'refund',[{type:'int',value:BigInt(refundId)}])).readCell().beginParse();
  assert.equal(record.loadCoins(),amount);assert(record.loadAddress().equals(t.wallet.address));
  return {query:String((await get(escrow,'nextRelease')).readBigNumber())};
 }) as any;
 await tonOnce(`demo-unrecorded-refund:${escrow.toRawString()}:${refundId}`,[internal({to:escrow,value:toNano('0.2'),body:refundBody(BigInt(refundId))})]);
 evidence.delivery=await wait(()=>verifyJettonDelivery(t.client,escrowWallet,userWallet,BigInt(refundQuery),amount));
 const after={locked:String((await get(escrow,'locked')).readBigNumber()),balance:String((await get(escrowWallet,'get_wallet_data')).readBigNumber())};
 assert.equal(after.locked,before.locked);assert.equal(after.balance,before.balance);
 evidence.after=after;evidence.complete=true;save();
 console.log('Underfunded deposit stranded, recovered by quorum and refunded to its sender. Evidence:',evidencePath);
}finally{tonJournal.close();}
