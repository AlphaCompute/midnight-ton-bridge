import {createHash} from 'node:crypto';
import {Address,Cell} from '@ton/core';
import type {TonClient4} from '@ton/ton';
import {finalizedBlock} from './ton-network.js';
import {u64} from './ton.js';

/** Read side of a deployed TON escrow: pinned identity, configuration and deposits. */
export type DepositReceipt={id:string;network:'ton-testnet';escrow:string;sequence:string;asset:0|1;amount:string;recipient:string;block:number;blockRoot:string};
export type EscrowPins={escrow:string;codeHash:string;configHash:string};
export type EscrowConfig={domain:string;committee:[string,string,string];master:Address;walletCodeHash:string;cap:bigint};
export function depositId(escrow:string,sequence:bigint):string {
 u64(sequence);
 return createHash('sha256').update(`alphaton-bridge:v1:ton-testnet:${Address.parse(escrow).toRawString()}:${sequence}`).digest('hex');
}
/** Escrow configuration at `block`, after checking the account is active and its code
 * and configuration cell match the deployment pins. */
export async function verifyEscrowPins(client:TonClient4,block:number,pins:EscrowPins):Promise<EscrowConfig>{
 const state=(await client.getAccount(block,Address.parse(pins.escrow))).account.state;
 if(state.type!=='active'||!state.code||!state.data)throw new Error('inactive escrow');
 if(Cell.fromBase64(state.code).hash().toString('hex')!==pins.codeHash.toLowerCase())throw new Error('unexpected escrow code');
 const config=Cell.fromBase64(state.data).beginParse().loadRef();
 if(config.hash().toString('hex')!==pins.configHash.toLowerCase())throw new Error('unexpected escrow configuration');
 const c=config.beginParse(),domain=c.loadBuffer(32).toString('hex'),keys=c.loadRef().beginParse();
 const committee=[0,1,2].map(()=>keys.loadBuffer(32).toString('hex')) as EscrowConfig['committee'];
 return {domain,committee,master:c.loadAddress(),walletCodeHash:c.loadRef().hash().toString('hex'),cap:c.loadUintBig(64)};
}
/** Trusted-RPC observer, not a TON light client. Committee members must use
 * independently operated RPC endpoints and pin the escrow code and config. */
export async function observeTonDeposit(client:TonClient4,config:EscrowPins&{asset:0|1;confirmationDepth:number},sequence:bigint):Promise<DepositReceipt>{
 const {block}=await finalizedBlock(client,config.confirmationDepth),address=Address.parse(config.escrow);
 await verifyEscrowPins(client,block,config);
 const result=await client.runMethod(block,address,'deposit',[{type:'int',value:sequence}]);
 if(result.exitCode!==0)throw new Error('deposit not found');
 const data=result.reader.readCell().beginParse(),amount=data.loadUintBig(64),recipient=data.loadBuffer(32).toString('hex');
 if(amount===0n)throw new Error('zero deposit');
 return {id:depositId(config.escrow,sequence),network:'ton-testnet',escrow:address.toRawString(),sequence:sequence.toString(),asset:config.asset,amount:amount.toString(),recipient,block,blockRoot:result.block.rootHash};
}
