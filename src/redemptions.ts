import {createHash} from 'node:crypto';
import {Address} from '@ton/core';
import {CompactTypeBytes,CompactTypeUnsignedInteger,persistentHash,type CompactType} from '@midnight-ntwrk/compact-runtime';
import type {ContractState} from '@midnight-ntwrk/ledger-v8';
import {ledger} from '../build/midnight/contract/index.js';
import {releaseDigest,uint64} from './ton.js';
export const circuitNames=['claim','redeem','addLiquidity','swap','removeLiquidity'] as const;
const hash=(x:Uint8Array)=>createHash('sha256').update(x).digest('hex');
const u8=new CompactTypeUnsignedInteger(255n,1),u64=new CompactTypeUnsignedInteger((1n<<64n)-1n,8),bytes32=new CompactTypeBytes(32);
const tuple:CompactType<[bigint,bigint,Uint8Array]>={
 alignment:()=>[...u8.alignment(),...u64.alignment(),...bytes32.alignment()],
 toValue:([a,n,r])=>[...u8.toValue(a),...u64.toValue(n),...bytes32.toValue(r)],
 fromValue:v=>[u8.fromValue(v),u64.fromValue(v),bytes32.fromValue(v)]
};
export function redemptionCommitment(asset:0|1,amount:bigint,recipient:Address){
 if(asset!==0&&asset!==1)throw new Error('invalid asset');uint64(amount);
 if(recipient.workChain!==0)throw new Error('only basechain supported');
 return persistentHash(tuple,[BigInt(asset),amount,recipient.hash]);
}
export type RedemptionRequest={id:string;asset:0|1;amount:string;recipient:string;transactionId:string};
export type MidnightPins={domain:string;maintenanceHash:string;verifiers:Record<typeof circuitNames[number],string>};
export function statePins(state:ContractState):MidnightPins{
 const verifiers={} as MidnightPins['verifiers'];
 for(const name of circuitNames){const op=state.operation(name);if(!op)throw new Error(`missing circuit ${name}`);verifiers[name]=hash(op.verifierKey);}
 return {domain:Buffer.from(ledger(state.data).domain).toString('hex'),maintenanceHash:hash(state.maintenanceAuthority.serialize()),verifiers};
}
/** Only call with a state snapshot from a successful, finalized transaction's block,
 * fetched independently by this committee member from its trusted indexer. */
export function verifyRedemption(state:ContractState,pins:MidnightPins,request:RedemptionRequest,escrows:[string,string]){
 const actual=statePins(state);
 if(actual.domain!==pins.domain||actual.maintenanceHash!==pins.maintenanceHash)throw new Error('unexpected domain or maintenance authority');
 if(state.operations().length!==circuitNames.length||circuitNames.some(n=>actual.verifiers[n]!==pins.verifiers[n]))throw new Error('unexpected verifier set');
 if(!/^[0-9a-f]{64}$/i.test(request.id))throw new Error('invalid redemption id');
 const id=Buffer.from(request.id,'hex'),recipient=Address.parse(request.recipient),amount=BigInt(request.amount),commitment=redemptionCommitment(request.asset,amount,recipient),data=ledger(state.data);
 if(!data.retired.member(id)||!Buffer.from(data.retired.lookup(id)).equals(commitment))throw new Error('retirement is absent or differs from requested release');
 return releaseDigest(Address.parse(escrows[request.asset]),Buffer.from(pins.domain,'hex'),id,amount,recipient);
}
