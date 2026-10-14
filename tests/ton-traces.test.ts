import {test} from 'node:test';
import assert from 'node:assert/strict';
import {beginCell,TupleReader,type Address,type Transaction} from '@ton/core';
import type {TonClient4} from '@ton/ton';
import {transferBody,DEPOSIT_ATTACHED_TON} from '../src/ton.js';
import {verifyAsset} from '../src/jettons.js';
import {observeFailedTransfer,observeUnrecordedCredit,verifyJettonDelivery,txLocator} from '../src/ton-traces.js';
import {accountId,rawTransfer} from './helpers/ton.js';
import {route,type Route} from './helpers/standard-route.js';

type Sent={transactions:Transaction[]};
/** First transaction at `addr` whose inbound internal message has the given bounced flag. */
const txAt=(res:Sent,addr:Address,bounced=false)=>{const t=res.transactions.find(tx=>tx.address===accountId(addr)&&tx.inMessage?.info.type==='internal'&&tx.inMessage.info.bounced===bounced);assert(t,'transaction expected');return t;};
const optAt=(res:Sent,addr:Address)=>res.transactions.find(tx=>tx.address===accountId(addr));

test('observeUnrecordedCredit: a recorded credit cannot borrow another credit\'s failed notification, and an aborted credit is not a credit',async()=>{
 const r=await route(1000n),to=Buffer.alloc(32,9);
 const stranded=await r.wallet.send(r.user.getSender(),rawTransfer({query:1n,amount:10n,to:r.escrow.address,response:r.user.address,forward:1n,recipient:to}));
 const recorded=await r.wallet.send(r.user.getSender(),transferBody(2n,40n,r.escrow.address,r.user.address,to),DEPOSIT_ATTACHED_TON);
 assert.equal(await r.escrow.getNumber('locked'),40n);r.setHistory([...stranded.transactions,...recorded.transactions]);
 const failedNotice=txLocator(optAt(stranded,r.escrow.address)!);
 assert.equal((await observeUnrecordedCredit(r.client,r.asset,r.escrow.address,{credit:txLocator(txAt(stranded,r.escrowWallet.address)),notification:failedNotice})).amount,10n);
 await assert.rejects(()=>observeUnrecordedCredit(r.client,r.asset,r.escrow.address,{credit:txLocator(txAt(recorded,r.escrowWallet.address)),notification:failedNotice}),/did not process this notification/);
 // The escrow wallet cannot absorb more: its credit transaction aborts and the jettons bounce home.
 await r.setBalance(r.escrowWallet.address,r.escrow.address,(1n<<120n)-1n);
 const aborted=await r.wallet.send(r.user.getSender(),rawTransfer({query:3n,amount:5n,to:r.escrow.address,response:r.user.address,forward:0n,recipient:to}));r.setHistory(aborted.transactions);
 const credit=txAt(aborted,r.escrowWallet.address);assert(credit.description.type==='generic'&&credit.description.aborted);
 await assert.rejects(()=>observeUnrecordedCredit(r.client,r.asset,r.escrow.address,{credit:txLocator(credit)}),/Not a successful/);
});

/** A downstream-rejected release (query 0), a delivered release (query 1) and another rejection (query 2), all of 100. */
async function releases(){
 const r=await route(1000n),send=(id:number)=>r.escrow.send(r.attacker.getSender(),r.release(Buffer.alloc(32,id),100n,r.user.address));
 await r.wallet.send(r.user.getSender(),transferBody(1n,1000n,r.escrow.address,r.user.address,Buffer.alloc(32,8)));
 const restore=await r.setBalance(r.wallet.address,r.user.address,(1n<<120n)-1n);const failed=await send(10);
 await restore();const delivered=await send(11);
 await r.setBalance(r.wallet.address,r.user.address,(1n<<120n)-1n);const failedAgain=await send(12);
 r.setHistory([...failed.transactions,...delivered.transactions,...failedAgain.transactions]);
 const trace=(res:Sent)=>({source:txLocator(txAt(res,r.escrowWallet.address)),rejection:txLocator(txAt(res,r.wallet.address)),bounce:txLocator(txAt(res,r.escrowWallet.address,true)),recipientWallet:r.wallet.address.toRawString()});
 return {r,failed:trace(failed),failedAgain:trace(failedAgain),delivered:{source:txLocator(txAt(delivered,r.escrowWallet.address)),credit:txLocator(txAt(delivered,r.wallet.address))}};
}
const observe=(r:Route,query:bigint,trace:Parameters<typeof observeFailedTransfer>[5])=>observeFailedTransfer(r.client,r.asset,r.escrow.address,query,100n,trace);

test('observeFailedTransfer: a delivered transfer, a mismatched query or unlinked transactions are not a failure',async()=>{
 const {r,failed,failedAgain,delivered}=await releases();
 assert.equal((await observe(r,0n,failed)).bounceTx,failed.bounce.hash);assert.equal((await observe(r,2n,failedAgain)).bounceTx,failedAgain.bounce.hash);
 // The recipient's successful credit is not a rejection, whether with its own source or another failure's.
 await assert.rejects(()=>observe(r,1n,{...failed,source:delivered.source,rejection:delivered.credit}),/actual recipient bounce/);
 await assert.rejects(()=>observe(r,0n,{...failed,rejection:delivered.credit}),/actual recipient bounce/);
 await assert.rejects(()=>observe(r,2n,failed),/mismatch/);
 // Genuine transactions from two different failures do not form one trace.
 await assert.rejects(()=>observe(r,0n,{...failed,rejection:failedAgain.rejection,bounce:failedAgain.bounce}),/do not link|mismatch/);
 await assert.rejects(()=>observe(r,0n,{...failed,bounce:failedAgain.bounce}),/do not link|mismatch/);
});

test('verifyJettonDelivery: a recipient rejection is never a delivery',async()=>{
 const {r}=await releases();
 assert.equal((await verifyJettonDelivery(r.client,r.escrowWallet.address,r.wallet.address,1n,100n)).amount,'100');
 for(const q of [0n,2n])await assert.rejects(()=>verifyJettonDelivery(r.client,r.escrowWallet.address,r.wallet.address,q,100n),/not found/);
});

test('verifyAsset: a deployed escrow wallet must be active, run the pinned code and report its own owner and master',async()=>{
 const r=await route(1000n),{client,asset,escrow,escrowWallet,master}=r;
 await r.wallet.send(r.user.getSender(),transferBody(1n,10n,escrow.address,r.user.address,Buffer.alloc(32,9)));
 assert.equal((await verifyAsset(client,asset,escrow.address)).wallet,escrowWallet.address.toRawString());
 const isWallet=(a:Address)=>a.equals(escrowWallet.address);
 const proxied=(over:Partial<Record<'getAccount'|'runMethod',(...a:any[])=>Promise<unknown>>>)=>new Proxy(client,{get:(t,p)=>(over as any)[p]??Reflect.get(t,p)}) as TonClient4;
 const account=(state:object)=>proxied({getAccount:async(b:number,a:Address)=>isWallet(a)?{account:{state}}:client.getAccount(b,a)});
 await assert.rejects(()=>verifyAsset(account({type:'frozen',stateHash:Buffer.alloc(32).toString('base64')}),asset,escrow.address),/Frozen/);
 await assert.rejects(()=>verifyAsset(account({type:'active',code:r.mc.toBoc().toString('base64'),data:null}),asset,escrow.address),/Deployed wallet code mismatch/);
 const data=(owner:Address,jetton:Address,code=r.wc,exitCode=0)=>proxied({runMethod:async(b:number,a:Address,name:string,args?:any[])=>isWallet(a)&&name==='get_wallet_data'
  ?{exitCode,reader:new TupleReader([{type:'int',value:10n},{type:'slice',cell:beginCell().storeAddress(owner).endCell()},{type:'slice',cell:beginCell().storeAddress(jetton).endCell()},{type:'cell',cell:code}])}:client.runMethod(b,a,name,args)});
 assert.equal((await verifyAsset(data(escrow.address,master.address),asset,escrow.address)).wallet,escrowWallet.address.toRawString());
 await assert.rejects(()=>verifyAsset(data(r.attacker.address,master.address),asset,escrow.address),/owner\/master\/code mismatch/);
 await assert.rejects(()=>verifyAsset(data(escrow.address,r.attacker.address),asset,escrow.address),/owner\/master\/code mismatch/);
 await assert.rejects(()=>verifyAsset(data(escrow.address,master.address,r.mc),asset,escrow.address),/owner\/master\/code mismatch/);
 await assert.rejects(()=>verifyAsset(data(escrow.address,master.address,r.wc,11),asset,escrow.address),/Wallet data unavailable/);
});
