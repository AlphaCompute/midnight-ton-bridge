import {Address,beginCell,Cell} from '@ton/core';
import type {TonClient4} from '@ton/ton';
import {OP,TonContract,storeQuorum,u64,positiveUint64} from './ton.js';
import {finalizedBlock} from './ton-network.js';
import {HEX32} from './encoding.js';

export type JettonAsset={asset:0|1;symbol:string;decimals:number;master:string;masterCodeHash:string;walletCodeBoc:string;walletCodeHash:string;cap:string;adapter:'tep74-reference'};
const codeHash=(boc:string|undefined)=>boc?Cell.fromBase64(boc).hash().toString('hex'):undefined;
export function validateAssets(value:unknown):[JettonAsset,JettonAsset]{
 if(!Array.isArray(value)||value.length!==2)throw new Error('Exactly two configured assets required');
 const masters=new Set<string>();
 for(const [i,a] of value.entries()){
  if(!a||a.asset!==i||a.adapter!=='tep74-reference'||typeof a.symbol!=='string'||!a.symbol.trim()||a.symbol.length>32||!Number.isInteger(a.decimals)||a.decimals<0||a.decimals>18)throw new Error('Invalid asset identity or metadata');
  if(typeof a.cap!=='string'||!/^\d+$/.test(a.cap))throw new Error('Invalid asset cap');positiveUint64(BigInt(a.cap));
  const master=Address.parse(a.master);if(master.workChain!==0||masters.has(master.toRawString()))throw new Error('Distinct basechain masters required');masters.add(master.toRawString());
  for(const hash of [a.masterCodeHash,a.walletCodeHash])if(typeof hash!=='string'||!HEX32.test(hash)||hash!==hash.toLowerCase())throw new Error('Invalid code hash');
  if(codeHash(a.walletCodeBoc)!==a.walletCodeHash)throw new Error('Wallet code hash mismatch');
 }
 return value as [JettonAsset,JettonAsset];
}
/** TEP-74 reference wallet (`balance, owner, master, wallet_code`) for an owner. */
export function referenceWallet(owner:Address,master:Address,code:Cell){
 if(owner.workChain!==0||master.workChain!==0)throw new Error('Basechain only');
 return TonContract.create(code,beginCell().storeCoins(0).storeAddress(owner).storeAddress(master).storeRef(code).endCell());
}
/** Master identity, wallet code and actual master getter must all agree. Storage
 * is not standardized by TEP-74; never infer compatibility from a token symbol. */
export async function verifyAsset(client:TonClient4,asset:JettonAsset,owner:Address){
 const {block}=await finalizedBlock(client);
 const master=Address.parse(asset.master),a=await client.getAccount(block,master);
 if(a.account.state.type!=='active'||codeHash(a.account.state.code??undefined)!==asset.masterCodeHash)throw new Error('Master code pin mismatch');
 const result=await client.runMethod(block,master,'get_jetton_data');if(result.exitCode!==0)throw new Error('get_jetton_data failed');
 // total_supply, mintable, admin_address, jetton_content, then jetton_wallet_code.
 result.reader.readBigNumber();result.reader.readBigNumber();result.reader.readAddressOpt();result.reader.readCell();
 if(result.reader.readCell().hash().toString('hex')!==asset.walletCodeHash)throw new Error('Master wallet code mismatch');
 const expected=referenceWallet(owner,master,Cell.fromBase64(asset.walletCodeBoc)).address;
 const actual=await client.runMethod(block,master,'get_wallet_address',[{type:'slice',cell:beginCell().storeAddress(owner).endCell()}]);
 if(actual.exitCode!==0||!actual.reader.readAddress().equals(expected))throw new Error('Unsupported wallet layout: master address derivation mismatch');
 const w=await client.getAccount(block,expected);
 if(w.account.state.type==='active'){
  if(codeHash(w.account.state.code??undefined)!==asset.walletCodeHash)throw new Error('Deployed wallet code mismatch');
  const data=await client.runMethod(block,expected,'get_wallet_data');if(data.exitCode!==0)throw new Error('Wallet data unavailable');data.reader.readBigNumber();
  if(!data.reader.readAddress().equals(owner)||!data.reader.readAddress().equals(master)||data.reader.readCell().hash().toString('hex')!==asset.walletCodeHash)throw new Error('Wallet owner/master/code mismatch');
 }else if(w.account.state.type==='frozen')throw new Error('Frozen wallet');
 return {block,master:master.toRawString(),wallet:expected.toRawString(),walletCodeHash:asset.walletCodeHash};
}
export function referenceMintBody(owner:Address,amount:bigint,queryId=0n){
 positiveUint64(amount);
 return beginCell().storeUint(OP.referenceMint,32).storeUint(queryId,64).storeAddress(owner).storeCoins(100_000_000n)
  .storeRef(beginCell().storeUint(OP.internalTransfer,32).storeUint(queryId,64).storeCoins(amount).storeAddress(null).storeAddress(owner).storeCoins(0).storeBit(false).endCell()).endCell();
}
export function failureDigest(escrow:Address,domain:Buffer,query:bigint,evidence:Buffer,pending:Cell){
 if(domain.length!==32||evidence.length!==32)throw new Error('Invalid failure attestation');u64(query);
 return beginCell().storeUint(OP.restoreFailed,32).storeAddress(escrow).storeBuffer(domain)
 .storeRef(beginCell().storeUint(query,64).storeBuffer(evidence).storeRef(pending).endCell()).endCell().hash();
}
export function failureBody(query:bigint,evidence:Buffer,a:number,b:number,sigA:Buffer,sigB:Buffer){
 if(evidence.length!==32)throw new Error('Invalid failure evidence');
 return storeQuorum(beginCell().storeUint(OP.restoreFailed,32).storeUint(query,64).storeBuffer(evidence),a,b,sigA,sigB).endCell();
}
export function unrecordedDigest(escrow:Address,domain:Buffer,evidence:Buffer,amount:bigint,from:Address){
 positiveUint64(amount);if(domain.length!==32||evidence.length!==32||from.workChain!==0)throw new Error('Invalid unrecorded-credit attestation');
 return beginCell().storeUint(OP.refundUnrecorded,32).storeAddress(escrow).storeBuffer(domain)
 .storeRef(beginCell().storeBuffer(evidence).storeUint(amount,64).storeAddress(from).endCell()).endCell().hash();
}
export function unrecordedBody(evidence:Buffer,amount:bigint,from:Address,a:number,b:number,sigA:Buffer,sigB:Buffer){
 positiveUint64(amount);if(evidence.length!==32||from.workChain!==0)throw new Error('Invalid unrecorded-credit evidence');
 return storeQuorum(beginCell().storeUint(OP.refundUnrecorded,32).storeBuffer(evidence).storeUint(amount,64).storeAddress(from),a,b,sigA,sigB).endCell();
}
