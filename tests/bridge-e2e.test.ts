import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TonContract,escrowData,releaseDigest,releaseBody,DEPOSIT_ATTACHED_TON} from '../src/ton.js';
import {observeTonDeposit,verifyEscrowPins} from '../src/escrow.js';
import {retirementRelease} from '../src/redemptions.js';
import {verifyJettonDelivery} from '../src/ton-traces.js';
import {BridgeClient} from '../src/sdk.js';
import {signClaim} from '../src/midnight.js';
import {TON_COMMITTEE,quorumSign} from './helpers/ton.js';
import {route} from './helpers/standard-route.js';
import {MIDNIGHT_SECRETS,deployMidnight,midnightCommittee,type Ctx} from './helpers/midnight.js';

test('standard route end to end: SDK deposit, observed receipt, Midnight claim, redemption, release and delivery',async()=>{
 const r=await route(1000n),m=deployMidnight({domain:r.domain}),[k0,k1,k2]=MIDNIGHT_SECRETS;
 const other=TonContract.create(r.ec,escrowData(r.domain,TON_COMMITTEE,r.attacker.address,r.wc,1000n)).address;
 const circuits=m.circuits as unknown as Record<string,(c:Ctx,...a:unknown[])=>{context:Ctx}>;
 const escrows:[string,string]=[r.escrow.address.toRawString(),other.toRawString()];
 const bridge=new BridgeClient({network:'local',domain:r.domain.toString('hex'),midnightAddress:m.address,escrows,committee:midnightCommittee()},
  {call:async(circuit,args)=>{m.context=circuits[circuit]!(m.context,...args).context;return circuit;}});
 const midnightRecipient='ab'.repeat(32);
 await r.wallet.send(r.user.getSender(),bridge.depositMessage(0,700n,midnightRecipient,r.user.address.toRawString(),1n),DEPOSIT_ATTACHED_TON);
 const pins={escrow:escrows[0],codeHash:r.ec.hash().toString('hex'),configHash:r.configHash};
 const parsed=await verifyEscrowPins(r.client,1,pins);
 assert.equal(parsed.domain,r.domain.toString('hex'));assert.deepEqual(parsed.committee,TON_COMMITTEE.map(k=>k.toString('hex')));
 assert(parsed.master.equals(r.master.address));assert.equal(parsed.walletCodeHash,r.asset.walletCodeHash);assert.equal(parsed.cap,1000n);
 await assert.rejects(()=>verifyEscrowPins(r.client,1,{...pins,codeHash:'00'.repeat(32)}),/unexpected escrow code/);
 const config={...pins,asset:0 as const,confirmationDepth:3};
 const receipt=await observeTonDeposit(r.client,config,0n);
 assert.equal(receipt.amount,'700');assert.equal(receipt.recipient,midnightRecipient);
 await assert.rejects(()=>observeTonDeposit(r.client,{...config,configHash:'00'.repeat(32)},0n),/configuration/);
 await assert.rejects(()=>observeTonDeposit(r.client,config,1n),/not found/);
 const digest=bridge.claimDigest(receipt);
 await bridge.claim(receipt,[{signer:2,signature:signClaim(digest,k2)},{signer:1,signature:signClaim(digest,k1)}]);
 assert.equal(m.state.circulating[0],await r.escrow.getNumber('locked'));
 await assert.rejects(()=>bridge.claim(receipt,[{signer:0,signature:signClaim(digest,k0)},{signer:1,signature:signClaim(digest,k1)}]),/replayed receipt/);
 // Retire on Midnight, then derive the release only from the recorded commitment.
 const nonce='cd'.repeat(32),id=bridge.redemptionId(nonce);await bridge.redeem(nonce,0,300n,r.user.address.toRawString());
 const request={id,asset:0 as const,amount:'300',recipient:r.user.address.toRawString(),transactionId:'local'},domain=r.domain.toString('hex'),data=m.state;
 assert.throws(()=>retirementRelease(data,domain,{...request,amount:'301'},escrows),/differs/);
 assert.throws(()=>retirementRelease(data,domain,{...request,recipient:r.attacker.address.toRawString()},escrows),/differs/);
 assert.throws(()=>retirementRelease(data,domain,{...request,asset:1},escrows),/differs/);
 const releaseHash=retirementRelease(data,domain,request,escrows);
 assert(releaseHash.equals(releaseDigest(r.escrow.address,r.domain,Buffer.from(id,'hex'),300n,r.user.address)));
 const [sa,sb]=quorumSign(releaseHash);
 const delivered=await r.escrow.send(r.attacker.getSender(),releaseBody(Buffer.from(id,'hex'),300n,r.user.address,0,2,sa,sb));
 r.setHistory(delivered.transactions);
 const proof=await verifyJettonDelivery(r.client,r.escrowWallet.address,r.wallet.address,0n,300n);assert.equal(proof.amount,'300');
 // Delivery proofs are exact: another amount or another sender wallet is not found.
 await assert.rejects(()=>verifyJettonDelivery(r.client,r.escrowWallet.address,r.wallet.address,0n,301n),/not found/);
 await assert.rejects(()=>verifyJettonDelivery(r.client,r.attacker.address,r.wallet.address,0n,300n),/not found/);
 // Backing equals circulation once settled, and the token balance matches the ledger.
 assert.equal(m.state.circulating[0],400n);assert.equal(await r.escrow.getNumber('locked'),400n);assert.equal(await r.balance(r.escrowWallet),400n);
 assert.equal(await r.balance(r.wallet),10000n-400n);
});
