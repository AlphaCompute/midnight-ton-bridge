import {TupleReader,type Address,type Transaction} from '@ton/core';
import type {Blockchain} from '@ton/sandbox';
import type {TonClient4} from '@ton/ton';
import {TON_TESTNET_ZERO_STATE} from '../../src/ton-network.js';
import {accountId} from './ton.js';

/** Sandbox-backed stand-in for a trusted TON v4 RPC on the pinned testnet: every read is
 * the latest state, and transaction history is whatever `history()` returns. */
export function sandboxRpc(chain:Blockchain,history:()=>Transaction[]=()=>[]){
 return {getLastBlock:async()=>({last:{seqno:20},init:{rootHash:TON_TESTNET_ZERO_STATE},now:Date.now()/1000}),
  getAccount:async(_b:number,address:Address)=>{const a=(await chain.getContract(address)).account.account?.storage.state;return {account:{state:a?.type==='active'?{type:'active',code:a.state.code!.toBoc().toString('base64'),data:a.state.data!.toBoc().toString('base64')}:{type:'uninit'}}};},
  runMethod:async(_b:number,address:Address,name:string,args:any[]=[])=>{try{const r=await chain.runGetMethod(address,name,args);return {exitCode:r.exitCode,reader:new TupleReader(r.stack),block:{rootHash:'sandbox'}};}catch{return {exitCode:9,reader:new TupleReader([]),block:{rootHash:'sandbox'}};}},
  getAccountLite:async()=>({account:{last:{lt:'99999999999999',hash:Buffer.alloc(32).toString('base64')}}}),
  getAccountTransactions:async(address:Address)=>history().filter(tx=>tx.address===accountId(address)).map(tx=>({tx}))} as unknown as TonClient4;
}
