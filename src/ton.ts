import { Address, beginCell, Cell, contractAddress, SendMode, toNano, type Contract, type ContractProvider, type Sender } from '@ton/core';
import { sign } from '@ton/crypto';

export class TonContract implements Contract {
  constructor(readonly address: Address, readonly init?: {code:Cell;data:Cell}) {}
  static create(code: Cell, data: Cell) { const init={code,data};return new TonContract(contractAddress(0,init),init); }
  async send(provider:ContractProvider, via:Sender, body:Cell=Cell.EMPTY, value=toNano('0.2')) {
    return provider.internal(via,{value,body,sendMode:SendMode.PAY_GAS_SEPARATELY});
  }
  async getNumber(provider:ContractProvider, method:string, id?:bigint) { return (await provider.get(method,id===undefined?[]:[{type:'int',value:id}])).stack.readBigNumber(); }
  async getCell(provider:ContractProvider, method:string, id:bigint) { return (await provider.get(method,[{type:'int',value:id}])).stack.readCell(); }
}
export function uint64(x:bigint) { if(x<=0n || x>=(1n<<64n))throw new Error('amount must be a positive uint64'); return x; }
export function escrowData(domain:Buffer, keys:Buffer[], master:Address, walletCode:Cell, cap=1_000_000_000_000n) {
  if(domain.length!==32 || keys.length!==3 || keys.some(k=>k.length!==32) || new Set(keys.map(k=>k.toString('hex'))).size!==3) throw new Error('invalid domain/committee');
  uint64(cap);const keyCell=beginCell();for(const k of keys)keyCell.storeBuffer(k);
  const config=beginCell().storeBuffer(domain).storeRef(keyCell.endCell()).storeAddress(master).storeRef(walletCode).storeUint(cap,64).endCell();
  return beginCell().storeRef(config).storeUint(0,64).storeUint(0,64).storeUint(0,64).storeBit(false).storeBit(false).storeBit(false).endCell();
}
export function walletData(owner:Address, master:Address, code:Cell) {return beginCell().storeCoins(0).storeAddress(owner).storeAddress(master).storeRef(code).endCell();}
export function jettonWallet(owner:Address,master:Address,code:Cell) {return TonContract.create(code,walletData(owner,master,code));}
export function transferBody(queryId:bigint, amount:bigint, destination:Address, response:Address, recipient?:Buffer) {
  uint64(amount);if(recipient && recipient.length!==32)throw new Error('recipient must be 32 bytes');
  const b=beginCell().storeUint(0x0f8a7ea5,32).storeUint(queryId,64).storeCoins(amount).storeAddress(destination).storeAddress(response).storeBit(false).storeCoins(toNano('0.01')).storeBit(false);
  if(recipient)b.storeBuffer(recipient);return b.endCell();
}
export function releaseDigest(escrow:Address,domain:Buffer,receipt:Buffer,amount:bigint,recipient:Address,recovery=false) {
  uint64(amount);if(domain.length!==32||receipt.length!==32)throw new Error('invalid digest field');
  if(recipient.workChain!==0)throw new Error('only basechain recipients supported');
  return beginCell().storeUint(recovery?0x42524702:0x42524701,32).storeAddress(escrow).storeBuffer(domain)
    .storeRef(beginCell().storeBuffer(receipt).storeUint(amount,64).storeAddress(recipient).endCell()).endCell().hash();
}
export function releaseBody(receipt:Buffer,amount:bigint,recipient:Address,a:number,b:number,sigA:Buffer,sigB:Buffer,recovery=false) {
  uint64(amount);if(a<0||a>=b||b>=3||sigA.length!==64||sigB.length!==64)throw new Error('invalid quorum');
  return beginCell().storeUint(recovery?0x42524702:0x42524701,32).storeBuffer(receipt).storeUint(amount,64).storeAddress(recipient).storeUint(a,8).storeUint(b,8)
    .storeRef(beginCell().storeBuffer(sigA).endCell()).storeRef(beginCell().storeBuffer(sigB).endCell()).endCell();
}
export function signRelease(digest:Buffer,secretKey:Buffer) {return sign(digest,secretKey);}
