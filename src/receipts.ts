import {createHash} from 'node:crypto';
import {Address,Cell} from '@ton/core';
import {TonClient4} from '@ton/ton';
export type DepositReceipt={id:string;network:'ton-testnet';escrow:string;sequence:string;asset:0|1;amount:string;recipient:string;block:number;blockRoot:string};
export function depositId(escrow:string,sequence:bigint):string {
 if(sequence<0n||sequence>=1n<<64n)throw new Error('invalid sequence');
 return createHash('sha256').update(`alphaton-bridge:v1:ton-testnet:${Address.parse(escrow).toRawString()}:${sequence}`).digest('hex');
}
/** Trusted-RPC observer, not a TON light client. Committee members must use
 * independently operated RPC endpoints and pin the escrow code and config. */
export async function observeTon(client:TonClient4,config:{escrow:string;asset:0|1;codeHash:string;configHash:string;confirmationDepth:number},sequence:bigint):Promise<DepositReceipt>{
 if(!Number.isSafeInteger(config.confirmationDepth)||config.confirmationDepth<1)throw new Error('invalid confirmation depth');
 const address=Address.parse(config.escrow),head=await client.getLastBlock(),block=head.last.seqno-config.confirmationDepth;
 if(Math.abs(Date.now()/1000-head.now)>120)throw new Error('stale TON RPC head');
 if(block<1)throw new Error('chain not ready');
 const account=await client.getAccount(block,address),state=account.account.state;
 if(state.type!=='active'||!state.code||!state.data)throw new Error('inactive escrow');
 if(Cell.fromBase64(state.code).hash().toString('hex')!==config.codeHash.toLowerCase())throw new Error('unexpected escrow code');
 if(Cell.fromBase64(state.data).beginParse().loadRef().hash().toString('hex')!==config.configHash.toLowerCase())throw new Error('unexpected escrow configuration');
 const result=await client.runMethod(block,address,'deposit',[{type:'int',value:sequence}]);
 if(result.exitCode!==0)throw new Error('deposit not found');
 const data=result.reader.readCell().beginParse(),amount=data.loadUintBig(64),recipient=data.loadBuffer(32).toString('hex');
 if(amount===0n)throw new Error('zero deposit');
 return {id:depositId(config.escrow,sequence),network:'ton-testnet',escrow:address.toRawString(),sequence:sequence.toString(),asset:config.asset,amount:amount.toString(),recipient,block,blockRoot:result.block.rootHash};
}
