import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Blockchain} from '@ton/sandbox';
import {beginCell,Cell,TupleReader} from '@ton/core';
import {keyPairFromSeed} from '@ton/crypto';
import type {TonClient4} from '@ton/ton';
import {compileTon} from '../scripts/compile-ton.js';
import {TonContract,escrowData,transferBody,releaseDigest,releaseBody,signRelease,refundBody} from '../src/ton.js';
import {referenceWallet,referenceMintBody,validateAssets,verifyAsset,failureDigest,failureBody,type JettonAsset} from '../src/jettons.js';
import {observeFailedTransfer} from '../src/ton-recovery.js';
import {TON_TESTNET_ZERO_STATE} from '../src/ton-network.js';

test('reference jetton interoperability, exact bounce recovery, refunds and asset pins',async()=>{
 const code=async(n:string)=>Cell.fromBase64((await compileTon(n)).codeBoc64);
 const [wc,mc,ec]=await Promise.all([code('reference-wallet'),code('reference-minter'),code('escrow-standard')]);
 const chain=await Blockchain.create(),owner=await chain.treasury('standard-owner'),user=await chain.treasury('standard-user'),attacker=await chain.treasury('standard-attacker');
 const keys=[1,2,3].map(n=>keyPairFromSeed(Buffer.alloc(32,n))),domain=Buffer.alloc(32,67);
 const master=chain.openContract(TonContract.create(mc,beginCell().storeCoins(0).storeAddress(owner.address).storeRef(Cell.EMPTY).storeRef(wc).endCell()));await master.send(owner.getSender());
 const escrow=chain.openContract(TonContract.create(ec,escrowData(domain,keys.map(k=>k.publicKey),master.address,wc,1000n)));await escrow.send(owner.getSender());
 const asset:JettonAsset={asset:0,symbol:'TOKEN',decimals:6,master:master.address.toRawString(),masterCodeHash:mc.hash().toString('hex'),walletCodeBoc:wc.toBoc().toString('base64'),walletCodeHash:wc.hash().toString('hex'),cap:'1000',adapter:'tep74-reference'};
 let history:any[]=[];
 const client={getLastBlock:async()=>({last:{seqno:20},init:{rootHash:TON_TESTNET_ZERO_STATE},now:Date.now()/1000}),
  getAccount:async(_b:number,address:typeof owner.address)=>{const a=(await chain.getContract(address)).account.account?.storage.state;return {account:{state:a?.type==='active'?{type:'active',code:a.state.code!.toBoc().toString('base64'),data:a.state.data!.toBoc().toString('base64')}:{type:'uninit'}}};},
  runMethod:async(_b:number,address:typeof owner.address,name:string,args:any[]=[])=>{const r=await chain.runGetMethod(address,name,args);return {exitCode:r.exitCode,reader:new TupleReader(r.stack)};},
  getAccountLite:async()=>({account:{last:{lt:'99999999999999',hash:Buffer.alloc(32).toString('base64')}}}),
  getAccountTransactions:async(address:typeof owner.address)=>history.filter(tx=>tx.address===BigInt('0x'+address.hash.toString('hex'))).map(tx=>({tx}))} as unknown as TonClient4;
 assert.equal((await verifyAsset(client,asset,escrow.address)).wallet,referenceWallet(escrow.address,master.address,wc).address.toRawString());
 await assert.rejects(()=>verifyAsset(client,{...asset,masterCodeHash:'ff'.repeat(32)},escrow.address),/pin mismatch/);
 await assert.rejects(()=>verifyAsset(client,{...asset,walletCodeHash:'ff'.repeat(32)},escrow.address),/wallet code mismatch/);
 const wrongLayout=new Proxy(client,{get:(target,prop)=>prop==='runMethod'?async(block:number,address:typeof owner.address,name:string,args:any[])=>name==='get_wallet_address'?{exitCode:0,reader:new TupleReader([{type:'slice',cell:beginCell().storeAddress(attacker.address).endCell()}])}:target.runMethod(block,address,name,args):Reflect.get(target,prop)});
 await assert.rejects(()=>verifyAsset(wrongLayout,asset,escrow.address),/derivation mismatch/);
 assert.throws(()=>validateAssets([asset,{...asset,asset:1}]),/Distinct/);
 assert.throws(()=>validateAssets([asset,{...asset,asset:1,master:attacker.address.toRawString(),walletCodeHash:'ff'.repeat(32)}]),/hash mismatch/);
 await master.send(owner.getSender(),referenceMintBody(user.address,10000n));const wallet=chain.openContract(referenceWallet(user.address,master.address,wc));assert.equal(await wallet.getNumber('get_wallet_data'),10000n);
 await wallet.send(user.getSender(),transferBody(1n,1000n,escrow.address,user.address,Buffer.alloc(32,8)));assert.equal(await escrow.getNumber('locked'),1000n);
 await wallet.send(user.getSender(),transferBody(2n,100n,escrow.address,user.address));assert.equal(await escrow.getNumber('refundCount'),1n);
 await escrow.send(attacker.getSender(),refundBody(0n));assert.equal(await wallet.getNumber('get_wallet_data'),9000n);
 const id=Buffer.alloc(32,9),digest=releaseDigest(escrow.address,domain,id,100n,user.address),body=releaseBody(id,100n,user.address,0,2,signRelease(digest,keys[0]!.secretKey),signRelease(digest,keys[2]!.secretKey));
 await escrow.send(attacker.getSender(),body);assert.equal(await escrow.getNumber('locked'),900n);assert.equal(await wallet.getNumber('get_wallet_data'),9100n);
 await escrow.send(attacker.getSender(),body);assert.equal(await wallet.getNumber('get_wallet_data'),9100n);
 // No privileged callback from the old custom wallet is accepted by this adapter.
 await escrow.send(attacker.getSender(),beginCell().storeUint(0x42524641,32).storeUint(1,64).storeCoins(100).endCell());assert.equal(await escrow.getNumber('locked'),900n);
 const original=(await chain.getContract(wallet.address)).account;assert(original.account?.storage.state.type==='active');const originalData=original.account.storage.state.state.data;const full=(await chain.getContract(wallet.address)).account;assert(full.account?.storage.state.type==='active');
 full.account.storage.state.state.data=beginCell().storeCoins((1n<<120n)-1n).storeAddress(user.address).storeAddress(master.address).storeRef(wc).endCell();await chain.setShardAccount(wallet.address,full);
 const failedId=Buffer.alloc(32,10),fd=releaseDigest(escrow.address,domain,failedId,100n,user.address),failedBody=releaseBody(failedId,100n,user.address,0,2,signRelease(fd,keys[0]!.secretKey),signRelease(fd,keys[2]!.secretKey));
 const result=await escrow.send(attacker.getSender(),failedBody);history=result.transactions;
 assert.equal(await escrow.getNumber('locked'),800n);const pending=await escrow.getCell('pending',2n);
 const sourceAddress=referenceWallet(escrow.address,master.address,wc).address;
 const source=history.find(tx=>tx.address===BigInt('0x'+sourceAddress.hash.toString('hex'))&&tx.inMessage?.info.type==='internal'&&!tx.inMessage.info.bounced);
 const rejection=history.find(tx=>tx.address===BigInt('0x'+wallet.address.hash.toString('hex')));
 const bounce=history.find(tx=>tx.address===BigInt('0x'+sourceAddress.hash.toString('hex'))&&tx.inMessage?.info.type==='internal'&&tx.inMessage.info.bounced);
 assert(source&&rejection&&bounce,'actual downstream bounce trace required');
 const locator=(tx:any)=>({lt:tx.lt.toString(),hash:tx.hash().toString('hex')});
 const trace={source:locator(source),rejection:locator(rejection),bounce:locator(bounce),recipientWallet:wallet.address.toRawString()};
 const observation=await observeFailedTransfer(client,asset,escrow.address,2n,100n,trace);
 await assert.rejects(()=>observeFailedTransfer(client,asset,escrow.address,1n,100n,trace),/mismatch/);
 await assert.rejects(()=>observeFailedTransfer(client,asset,escrow.address,2n,101n,trace),/mismatch/);
 await assert.rejects(()=>observeFailedTransfer(client,asset,escrow.address,2n,100n,{...trace,bounce:trace.source}));
 const recoverDigest=failureDigest(escrow.address,domain,2n,observation.evidence,pending),recover=failureBody(2n,observation.evidence,0,2,signRelease(recoverDigest,keys[0]!.secretKey),signRelease(recoverDigest,keys[2]!.secretKey));
 const wrong=failureBody(2n,Buffer.alloc(32,1),0,2,signRelease(recoverDigest,keys[0]!.secretKey),signRelease(recoverDigest,keys[2]!.secretKey));
 await escrow.send(attacker.getSender(),wrong);assert.equal(await escrow.getNumber('locked'),800n);
 await escrow.send(attacker.getSender(),recover);assert.equal(await escrow.getNumber('locked'),900n);
 await escrow.send(attacker.getSender(),recover);assert.equal(await escrow.getNumber('locked'),900n);
 original.account.storage.state.state.data=originalData;await chain.setShardAccount(wallet.address,original);await escrow.send(attacker.getSender(),failedBody);assert.equal(await escrow.getNumber('locked'),800n);assert.equal(await wallet.getNumber('get_wallet_data'),9200n);
});
