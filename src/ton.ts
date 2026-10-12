import { Address, beginCell, Cell, contractAddress, SendMode, toNano, type Builder, type Contract, type ContractProvider, type Sender } from '@ton/core';
import { sign } from '@ton/crypto';

/** Message opcodes shared with the TON contracts. */
export const OP={
  jettonTransfer:0x0f8a7ea5, internalTransfer:0x178d4519, transferNotification:0x7362d09c, excesses:0xd53276db, bounced:0xffffffff,
  release:0x42524701, refund:0x42524703, restoreFailed:0x42524704, refundUnrecorded:0x42524705,
  referenceMint:21,
} as const;

export class TonContract implements Contract {
  constructor(readonly address: Address, readonly init?: {code:Cell;data:Cell}) {}
  static create(code: Cell, data: Cell) { const init={code,data};return new TonContract(contractAddress(0,init),init); }
  async send(provider:ContractProvider, via:Sender, body:Cell=Cell.EMPTY, value=toNano('0.2')) {
    return provider.internal(via,{value,body,sendMode:SendMode.PAY_GAS_SEPARATELY});
  }
  async getNumber(provider:ContractProvider, method:string, id?:bigint) { return (await provider.get(method,id===undefined?[]:[{type:'int',value:id}])).stack.readBigNumber(); }
  async getCell(provider:ContractProvider, method:string, id:bigint) { return (await provider.get(method,[{type:'int',value:id}])).stack.readCell(); }
}
/** Midnight per-asset circulation cap for this release. Each TON escrow cap must not
 * exceed it, or a locked deposit could become unclaimable. */
export const BRIDGE_CAP=1_000_000_000_000n;
/** A positive uint64 amount (the bridge never moves zero). */
export function positiveUint64(x:bigint) { if(x<=0n || x>=(1n<<64n))throw new Error('amount must be a positive uint64'); return x; }
/** Any uint64, including zero: sequence numbers, IDs and minima. */
export function u64(x:bigint) { if(x<0n || x>=(1n<<64n))throw new Error('value must be a uint64'); return x; }
export function assertAsset(asset:unknown):asserts asset is 0|1 { if(asset!==0&&asset!==1)throw new Error('unknown asset'); }
/** Two ascending committee indices and their Ed25519 signatures, as every quorum body ends. */
export function storeQuorum(b:Builder,a:number,c:number,sigA:Buffer,sigB:Buffer) {
  if(!Number.isInteger(a)||!Number.isInteger(c)||a<0||a>=c||c>2||sigA.length!==64||sigB.length!==64)throw new Error('invalid quorum');
  return b.storeUint(a,8).storeUint(c,8).storeRef(beginCell().storeBuffer(sigA).endCell()).storeRef(beginCell().storeBuffer(sigB).endCell());
}
/** Initial data for `escrow-standard.tolk`: refunds, pending and recovered credits. */
export function escrowData(domain:Buffer, keys:Buffer[], master:Address, walletCode:Cell, cap=BRIDGE_CAP) {
  if(domain.length!==32 || keys.length!==3 || keys.some(k=>k.length!==32) || new Set(keys.map(k=>k.toString('hex'))).size!==3) throw new Error('invalid domain/committee');
  positiveUint64(cap);const keyCell=beginCell();for(const k of keys)keyCell.storeBuffer(k);
  const config=beginCell().storeBuffer(domain).storeRef(keyCell.endCell()).storeAddress(master).storeRef(walletCode).storeUint(cap,64).endCell();
  // Recovery: next refund, then empty refunds, pending and recovered dictionaries.
  const recovery=beginCell().storeUint(0,64).storeUint(0,3);
  return beginCell().storeRef(config).storeUint(0,64).storeUint(0,64).storeUint(0,64).storeRef(recovery.endCell()).storeBit(false).storeBit(false).endCell();
}
/** TON forwarded with each deposit notification; it pays the escrow's processing gas.
 * A wallet forwarding much less (wallet apps often forward 1 nanoton) leaves the escrow
 * unable to record either a deposit or a refund, stranding the jettons. */
export const DEPOSIT_FORWARD_TON=toNano('0.01');
/** TON to attach when sending a deposit body to the sender's jetton wallet. */
export const DEPOSIT_ATTACHED_TON=toNano('0.1');
export function transferBody(queryId:bigint, amount:bigint, destination:Address, response:Address, recipient?:Buffer) {
  positiveUint64(amount);if(recipient && recipient.length!==32)throw new Error('recipient must be 32 bytes');
  const b=beginCell().storeUint(OP.jettonTransfer,32).storeUint(queryId,64).storeCoins(amount).storeAddress(destination).storeAddress(response).storeBit(false).storeCoins(DEPOSIT_FORWARD_TON).storeBit(false);
  if(recipient)b.storeBuffer(recipient);return b.endCell();
}
export function releaseDigest(escrow:Address,domain:Buffer,receipt:Buffer,amount:bigint,recipient:Address) {
  positiveUint64(amount);if(domain.length!==32||receipt.length!==32)throw new Error('invalid digest field');
  if(recipient.workChain!==0)throw new Error('only basechain recipients supported');
  return beginCell().storeUint(OP.release,32).storeAddress(escrow).storeBuffer(domain)
    .storeRef(beginCell().storeBuffer(receipt).storeUint(amount,64).storeAddress(recipient).endCell()).endCell().hash();
}
export function releaseBody(receipt:Buffer,amount:bigint,recipient:Address,a:number,b:number,sigA:Buffer,sigB:Buffer) {
  positiveUint64(amount);if(receipt.length!==32||recipient.workChain!==0)throw new Error('invalid release');
  return storeQuorum(beginCell().storeUint(OP.release,32).storeBuffer(receipt).storeUint(amount,64).storeAddress(recipient),a,b,sigA,sigB).endCell();
}
/** Ed25519 signature over any committee digest (release, failure or unrecorded credit). */
export function signTonDigest(digest:Buffer,secretKey:Buffer) {return sign(digest,secretKey);}

export function refundBody(id:bigint){return beginCell().storeUint(OP.refund,32).storeUint(u64(id),64).endCell();}
