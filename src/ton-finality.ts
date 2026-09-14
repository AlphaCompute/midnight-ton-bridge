import {Address,beginCell,storeMessage,type Transaction} from '@ton/core';
import type {TonClient4} from '@ton/ton';
const successful=(tx:Transaction)=>tx.description.type==='generic'&&!tx.description.aborted&&tx.description.computePhase.type==='vm'&&tx.description.computePhase.success&&(!tx.description.actionPhase||tx.description.actionPhase.success);
/** Trusted-RPC trace validation: finalized recipient credit and matching outgoing
 * internal message from the expected jetton sender wallet. */
export async function verifyJettonDelivery(client:TonClient4,from:Address,to:Address,queryId:bigint,amount:bigint,depth=3){
 const head=await client.getLastBlock();if(Math.abs(Date.now()/1000-head.now)>120||depth<1)throw new Error('stale head or unsafe depth');
 const block=head.last.seqno-depth;
 const recent=async(address:Address)=>{const a=await client.getAccountLite(block,address);if(!a.account.last)throw new Error('no transaction history');return client.getAccountTransactions(address,BigInt(a.account.last.lt),Buffer.from(a.account.last.hash,'base64'));};
 const destination=await recent(to),source=await recent(from);
 for(const row of destination){const m=row.tx.inMessage;if(!m||m.info.type!=='internal'||m.info.bounced||!m.info.src.equals(from)||!successful(row.tx))continue;
  const b=m.body.beginParse();if(b.remainingBits<96||b.loadUint(32)!==0x178d4519||b.loadUintBig(64)!==queryId||b.loadCoins()!==amount)continue;
  const hash=beginCell().store(storeMessage(m)).endCell().hash();
  const parent=source.find(r=>successful(r.tx)&&[...r.tx.outMessages.values()].some(out=>beginCell().store(storeMessage(out)).endCell().hash().equals(hash)));
  if(!parent)throw new Error('recipient credit has no matching successful sender transaction in recent history');
  return {block,queryId:queryId.toString(),amount:amount.toString(),from:from.toRawString(),to:to.toRawString(),sourceTx:parent.tx.hash().toString('hex'),recipientTx:row.tx.hash().toString('hex'),messageHash:hash.toString('hex')};
 }
 throw new Error('matching finalized jetton recipient credit not found');
}
