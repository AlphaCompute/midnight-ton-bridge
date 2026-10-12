import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Blockchain,internal as sandboxInternal} from '@ton/sandbox';
import {beginCell,toNano,type Cell} from '@ton/core';
import {OP,TonContract,legacyEscrowData,legacyJettonWallet,transferBody,releaseDigest,releaseBody,refundBody} from '../src/ton.js';
import {verifyJettonDelivery} from '../src/ton-traces.js';
import {TON_COMMITTEE,compiled,quorumSign,exitOf,overrideWalletData,rawTransfer} from './helpers/ton.js';
import {sandboxRpc} from './helpers/ton-rpc.js';

// The legacy custom-wallet escrow (`escrow.tolk`) and its fixture jetton stay covered
// because escrows built from them remain deployed on TON testnet.
test('legacy escrow and fixture wallet: lock, release, refunds and adversarial rejection',async()=>{
 const [escrowCode,walletCode,minterCode]=await Promise.all([compiled('escrow'),compiled('test-wallet'),compiled('test-minter')]);
 const chain=await Blockchain.create(),owner=await chain.treasury('owner'),user=await chain.treasury('user'),attacker=await chain.treasury('attacker');
 const domain=Buffer.alloc(32,55);
 const minter=chain.openContract(TonContract.create(minterCode,beginCell().storeAddress(owner.address).storeRef(walletCode).storeUint(0,64).storeUint(1_000_000,64).endCell()));
 await minter.send(owner.getSender());
 const escrow=chain.openContract(TonContract.create(escrowCode,legacyEscrowData(domain,TON_COMMITTEE,minter.address,walletCode,1000n)));
 await escrow.send(owner.getSender());
 await minter.send(owner.getSender(),beginCell().storeUint(OP.legacyMint,32).storeAddress(user.address).storeUint(10000,64).endCell());
 const wallet=chain.openContract(legacyJettonWallet(user.address,minter.address,walletCode)),balance=()=>wallet.getNumber('get_wallet_data');
 const send=async(body:Cell,value?:bigint)=>exitOf(await escrow.send(attacker.getSender(),body,value),escrow.address);
 // A forged bounce cannot credit the fixture wallet.
 const fakeBounce=beginCell().storeUint(OP.bounced,32).storeUint(OP.internalTransfer,32).storeUint(0,64).storeCoins(9999).endCell();
 const forged=await chain.sendMessage(sandboxInternal({from:attacker.address,to:wallet.address,value:toNano('0.05'),bounced:true,body:fakeBounce}));
 // Exit 9: no pending transfer matches the forged bounce.
 assert.equal(exitOf(forged,wallet.address),9);
 assert.equal(await balance(),10000n);
 // The fixture wallet refuses a transfer without a deposit notification.
 const noNotification=await wallet.send(user.getSender(),rawTransfer({query:90n,amount:100n,to:escrow.address,response:user.address,forward:0n}));
 assert.equal(exitOf(noNotification,wallet.address),403);assert.equal(await balance(),10000n);assert.equal(await escrow.getNumber('depositCount'),0n);
 await wallet.send(user.getSender(),transferBody(1n,1000n,escrow.address,user.address,Buffer.alloc(32,9)));
 assert.equal(await escrow.getNumber('locked'),1000n);assert.equal(await escrow.getNumber('depositCount'),1n);
 const deposit=(await escrow.getCell('deposit',0n)).beginParse();assert.equal(deposit.loadUintBig(64),1000n);assert.equal(deposit.loadBuffer(32).toString('hex'),Buffer.alloc(32,9).toString('hex'));
 // Anyone may relay a quorum release; nobody can redirect it.
 const receipt=Buffer.alloc(32,7),digest=releaseDigest(escrow.address,domain,receipt,400n,user.address),[sa,sb]=quorumSign(digest);
 const body=releaseBody(receipt,400n,user.address,0,2,sa,sb);
 const delivered=await escrow.send(attacker.getSender(),body);assert.equal(exitOf(delivered,escrow.address),0);
 assert.equal(await escrow.getNumber('locked'),600n);assert.equal(await balance(),9400n);
 const fromWallet=legacyJettonWallet(escrow.address,minter.address,walletCode).address;
 assert.equal((await verifyJettonDelivery(sandboxRpc(chain,()=>delivered.transactions),fromWallet,wallet.address,0n,400n)).amount,'400');
 assert.equal(await send(body),406);
 assert.equal(await send(releaseBody(Buffer.alloc(32,8),400n,attacker.address,0,2,sa,sb)),407);
 // A deposit notification not sent by the escrow's own jetton wallet is rejected.
 const fake=beginCell().storeUint(OP.transferNotification,32).storeUint(5,64).storeCoins(1000).storeAddress(user.address).storeBit(false).storeBuffer(Buffer.alloc(32,4)).endCell();
 assert.equal(await send(fake),401);
 assert.equal(exitOf(await escrow.send(user.getSender(),body,toNano('0.01')),escrow.address),403);
 assert.equal(await escrow.getNumber('locked'),600n);
 // A malformed direct deposit reaches the token wallet but not the bridge ledger.
 await wallet.send(user.getSender(),transferBody(2n,100n,escrow.address,user.address));
 assert.equal(await escrow.getNumber('locked'),600n);assert.equal(await balance(),9300n);assert.equal(await escrow.getNumber('refundCount'),1n);
 const record=(await escrow.getCell('refund',0n)).beginParse();assert.equal(record.loadUintBig(64),100n);assert(record.loadAddress().equals(user.address));
 assert.equal(await send(refundBody(0n)),0);
 assert.equal(await escrow.getNumber('locked'),600n);assert.equal(await balance(),9400n);
 // Exit 9: a paid refund is deleted, so it cannot be claimed twice.
 assert.equal(await send(refundBody(0n)),9);assert.equal(await balance(),9400n);
 // The old arbitrary recovery opcode is no longer accepted.
 assert.equal(await send(beginCell().storeUint(0x42524702,32).endCell()),400);assert.equal(await escrow.getNumber('locked'),600n);
 // A cap-exceeding deposit must not create an unclaimable registered receipt.
 await wallet.send(user.getSender(),transferBody(3n,500n,escrow.address,user.address,Buffer.alloc(32,9)));
 assert.equal(await escrow.getNumber('locked'),600n);assert.equal(await escrow.getNumber('depositCount'),1n);
 assert.equal(await send(refundBody(1n)),0);
 assert.equal(await balance(),9400n);assert.equal(await escrow.getNumber('locked'),600n);
 // A forged downstream failure must never unlock collateral or clear replay state.
 assert.equal(await send(beginCell().storeUint(OP.legacyWalletFailure,32).storeUint(0,64).storeCoins(400).endCell()),401);
 assert.equal(await escrow.getNumber('locked'),600n);assert.equal(await escrow.getNumber('releaseState',BigInt('0x'+receipt.toString('hex'))),1n);
 assert.equal(await send(refundBody(999n)),9);assert.equal(await balance(),9400n);
 // Force the destination's uint64 balance check to reject an internal transfer:
 // a genuine TVM downstream bounce, not just an injected callback.
 const restore=await overrideWalletData(chain,wallet.address,beginCell().storeCoins((1n<<64n)-1n).storeAddress(user.address).storeAddress(minter.address).storeRef(walletCode).storeBit(false).endCell());
 const retryId=Buffer.alloc(32,44),[ra,rb]=quorumSign(releaseDigest(escrow.address,domain,retryId,100n,user.address));
 const retryBody=releaseBody(retryId,100n,user.address,0,2,ra,rb);
 assert.equal(await send(retryBody),0);
 assert.equal(await escrow.getNumber('locked'),600n);assert.equal(await escrow.getNumber('releaseState',BigInt('0x'+retryId.toString('hex'))),0n);
 await restore();
 assert.equal(await send(retryBody),0);
 assert.equal(await escrow.getNumber('locked'),500n);assert.equal(await balance(),9500n);
});
