import {TON_TESTNET_ZERO_STATE} from '../src/ton-network.js';
import {verifyJettonDelivery} from '../src/ton-finality.js';
import type {TonClient4} from '@ton/ton';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Blockchain,internal as sandboxInternal} from '@ton/sandbox';
import {beginCell,Cell,toNano} from '@ton/core';
import {keyPairFromSeed} from '@ton/crypto';
import {Contract as MidnightContract,ledger,pureCircuits} from '../build/midnight/contract/index.js';
import {createConstructorContext,createCircuitContext,sampleContractAddress} from '@midnight-ntwrk/compact-runtime';
import {verifyingKey,signClaim,witnesses} from '../src/midnight.js';
import {depositId} from '../src/receipts.js';
import {compileTon} from '../scripts/compile-ton.js';
import {TonContract,escrowData,jettonWallet,transferBody,releaseDigest,releaseBody,signRelease,refundBody} from '../src/ton.js';

test('TVM plus compiled Midnight runtime: lock, claim, retire, release and adversarial rejection',async()=>{
  const code=async(n:string)=>Cell.fromBase64((await compileTon(n)).codeBoc64);
  const [escrowCode,walletCode,minterCode]=[await code('escrow'),await code('test-wallet'),await code('test-minter')];
  const chain=await Blockchain.create();const owner=await chain.treasury('owner');const user=await chain.treasury('user');const attacker=await chain.treasury('attacker');
  const keys=[1,2,3].map(n=>keyPairFromSeed(Buffer.alloc(32,n)));
  const domain=Buffer.alloc(32,55);
  const minter=chain.openContract(TonContract.create(minterCode,beginCell().storeAddress(owner.address).storeRef(walletCode).storeUint(0,64).storeUint(1_000_000,64).endCell()));
  await minter.send(owner.getSender());
  const escrow=chain.openContract(TonContract.create(escrowCode,escrowData(domain,keys.map(k=>k.publicKey),minter.address,walletCode,1000n)));
  await escrow.send(owner.getSender());
  await minter.send(owner.getSender(),beginCell().storeUint(0x4d494e54,32).storeAddress(user.address).storeUint(10000,64).endCell());
  const wallet=chain.openContract(jettonWallet(user.address,minter.address,walletCode));
  const fakeBounce=beginCell().storeUint(0xffffffff,32).storeUint(0x178d4519,32).storeUint(0,64).storeCoins(9999).endCell();
  await chain.sendMessage(sandboxInternal({from:attacker.address,to:wallet.address,value:toNano('0.05'),bounced:true,body:fakeBounce}));
  assert.equal(await wallet.getNumber('get_wallet_data'),10000n);
  const noNotification=beginCell().storeUint(0x0f8a7ea5,32).storeUint(90,64).storeCoins(100).storeAddress(escrow.address).storeAddress(user.address).storeBit(false).storeCoins(0).storeBit(false).endCell();
  await wallet.send(user.getSender(),noNotification);assert.equal(await wallet.getNumber('get_wallet_data'),10000n);assert.equal(await escrow.getNumber('depositCount'),0n);
  const mintResult=await wallet.getNumber('get_wallet_data');assert.equal(mintResult,10000n);
  await wallet.send(user.getSender(),transferBody(1n,1000n,escrow.address,user.address,Buffer.alloc(32,9)));
  assert.equal(await escrow.getNumber('locked'),1000n);assert.equal(await escrow.getNumber('depositCount'),1n);
  const deposit=(await escrow.getCell('deposit',0n)).beginParse();assert.equal(deposit.loadUintBig(64),1000n);assert.equal(deposit.loadBuffer(32).toString('hex'),Buffer.alloc(32,9).toString('hex'));
  const midnight=new MidnightContract(witnesses),midAddress=sampleContractAddress(),midKeys=[11n,22n,33n];
  const initial=midnight.initialState(createConstructorContext({},'00'.repeat(32)),domain,midKeys.map(verifyingKey),1000000n);
  let ctx=createCircuitContext(midAddress,'00'.repeat(32),initial.currentContractState,{});
  const depositReceipt=Buffer.from(depositId(escrow.address.toRawString(),0n),'hex');
  const claimHash=pureCircuits.claimDigest(domain,Buffer.from(midAddress,'hex'),depositReceipt,0n,1000n,{bytes:Buffer.alloc(32,9)});
  ctx=midnight.impureCircuits.claim(ctx,depositReceipt,0n,1000n,{bytes:Buffer.alloc(32,9)},0n,2n,signClaim(claimHash,midKeys[0]!),signClaim(claimHash,midKeys[2]!)).context;
  assert.equal(ledger(ctx.currentQueryContext.state).circulating[0],await escrow.getNumber('locked'));
  const receipt=Buffer.alloc(32,7);
  ctx=midnight.impureCircuits.redeem(ctx,receipt,0n,400n,user.address.hash).context;
  assert(ledger(ctx.currentQueryContext.state).retired.member(receipt));const digest=releaseDigest(escrow.address,domain,receipt,400n,user.address);
  const body=releaseBody(receipt,400n,user.address,0,2,signRelease(digest,keys[0]!.secretKey),signRelease(digest,keys[2]!.secretKey));
  const delivered=await escrow.send(attacker.getSender(),body); // anyone may relay, cannot redirect
  assert.equal(await escrow.getNumber('locked'),600n);assert.equal(await wallet.getNumber('get_wallet_data'),9400n);
  assert.equal(ledger(ctx.currentQueryContext.state).circulating[0],await escrow.getNumber('locked'));
  const traceClient={getLastBlock:async()=>({last:{seqno:20},init:{rootHash:TON_TESTNET_ZERO_STATE},now:Date.now()/1000}),getAccountLite:async()=>({account:{last:{lt:'1',hash:Buffer.alloc(32).toString('base64')}}}),getAccountTransactions:async(address:typeof wallet.address)=>delivered.transactions.filter(tx=>tx.address===BigInt('0x'+address.hash.toString('hex'))).map(tx=>({tx}))} as unknown as TonClient4;
  const fromWallet=jettonWallet(escrow.address,minter.address,walletCode).address;
  assert.equal((await verifyJettonDelivery(traceClient,fromWallet,wallet.address,0n,400n)).amount,'400');
  await assert.rejects(()=>verifyJettonDelivery(traceClient,fromWallet,wallet.address,0n,401n),/not found/);
  await assert.rejects(()=>verifyJettonDelivery(traceClient,attacker.address,wallet.address,0n,400n),/not found/);
  await escrow.send(attacker.getSender(),body);assert.equal(await escrow.getNumber('locked'),600n);
  const wrong=releaseBody(Buffer.alloc(32,8),400n,attacker.address,0,2,signRelease(digest,keys[0]!.secretKey),signRelease(digest,keys[2]!.secretKey));
  await escrow.send(attacker.getSender(),wrong);assert.equal(await escrow.getNumber('locked'),600n);
  const fake=beginCell().storeUint(0x7362d09c,32).storeUint(5,64).storeCoins(1000).storeAddress(user.address).storeBit(false).storeBuffer(Buffer.alloc(32,4)).endCell();
  await escrow.send(attacker.getSender(),fake);assert.equal(await escrow.getNumber('locked'),600n);
  await escrow.send(user.getSender(),body,toNano('0.01'));assert.equal(await escrow.getNumber('locked'),600n);
  // A malformed direct deposit reaches the token wallet but not the bridge ledger.
  await wallet.send(user.getSender(),transferBody(2n,100n,escrow.address,user.address));
  assert.equal(await escrow.getNumber('locked'),600n);
  assert.equal(await wallet.getNumber('get_wallet_data'),9300n);
  assert.equal(await escrow.getNumber('refundCount'),1n);
  const record=(await escrow.getCell('refund',0n)).beginParse();assert.equal(record.loadUintBig(64),100n);assert(record.loadAddress().equals(user.address));
  await escrow.send(attacker.getSender(),refundBody(0n));
  assert.equal(await escrow.getNumber('locked'),600n);assert.equal(await wallet.getNumber('get_wallet_data'),9400n);
  await escrow.send(attacker.getSender(),refundBody(0n));assert.equal(await wallet.getNumber('get_wallet_data'),9400n);
  // The old arbitrary recovery opcode is no longer accepted.
  await escrow.send(attacker.getSender(),beginCell().storeUint(0x42524702,32).endCell());assert.equal(await escrow.getNumber('locked'),600n);
  // A cap-exceeding deposit must not create an unclaimable registered receipt.
  await wallet.send(user.getSender(),transferBody(3n,500n,escrow.address,user.address,Buffer.alloc(32,9)));
  assert.equal(await escrow.getNumber('locked'),600n);assert.equal(await escrow.getNumber('depositCount'),1n);
  await escrow.send(attacker.getSender(),refundBody(1n));
  assert.equal(await wallet.getNumber('get_wallet_data'),9400n);assert.equal(await escrow.getNumber('locked'),600n);
  // A forged downstream failure must never unlock collateral or clear replay state.
  await escrow.send(attacker.getSender(),beginCell().storeUint(0x42524641,32).storeUint(0,64).storeCoins(400).endCell());
  assert.equal(await escrow.getNumber('locked'),600n);assert.equal(await escrow.getNumber('releaseState',BigInt('0x'+receipt.toString('hex'))),1n);
  await escrow.send(attacker.getSender(),refundBody(999n));assert.equal(await wallet.getNumber('get_wallet_data'),9400n);
  // Force the destination's uint64 balance check to reject an internal transfer.
  // Exercise a genuine TVM downstream bounce, not just an injected callback.
  const original=(await chain.getContract(wallet.address)).account;
  assert(original.account?.storage.state.type==='active');const originalData=original.account.storage.state.state.data;
  const full=(await chain.getContract(wallet.address)).account;
  assert(full.account?.storage.state.type==='active');
  full.account.storage.state.state.data=beginCell().storeCoins((1n<<64n)-1n).storeAddress(user.address).storeAddress(minter.address).storeRef(walletCode).storeBit(false).endCell();
  await chain.setShardAccount(wallet.address,full);
  const retryId=Buffer.alloc(32,44),retryDigest=releaseDigest(escrow.address,domain,retryId,100n,user.address);
  const retryBody=releaseBody(retryId,100n,user.address,0,2,signRelease(retryDigest,keys[0]!.secretKey),signRelease(retryDigest,keys[2]!.secretKey));
  await escrow.send(attacker.getSender(),retryBody);
  assert.equal(await escrow.getNumber('locked'),600n);assert.equal(await escrow.getNumber('releaseState',BigInt('0x'+retryId.toString('hex'))),0n);
  original.account.storage.state.state.data=originalData;
  await chain.setShardAccount(wallet.address,original);
  await escrow.send(attacker.getSender(),retryBody);
  assert.equal(await escrow.getNumber('locked'),500n);assert.equal(await wallet.getNumber('get_wallet_data'),9500n);
});
