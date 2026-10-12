import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {Address} from '@ton/core';
import {createConstructorContext,createCircuitContext,sampleContractAddress} from '@midnight-ntwrk/compact-runtime';
import {ContractState,ContractOperation,ContractMaintenanceAuthority} from '@midnight-ntwrk/compact-runtime';
import {Contract,pureCircuits} from '../build/midnight/contract/index.js';
import {signClaim,verifyingKey,witnesses} from '../src/midnight.js';
import {circuitNames,statePins,verifyRedemption} from '../src/redemptions.js';
import {releaseDigest} from '../src/ton.js';

const keyed=circuitNames.every(n=>existsSync(`build/midnight/keys/${n}.verifier`));
test('signer verification pins verifier keys, authority and domain before using a retirement',{skip:keyed?false:'requires npm run compile:midnight -- --proof'},()=>{
 const domain=Buffer.alloc(32,5),c=new Contract(witnesses),init=c.initialState(createConstructorContext({},'00'.repeat(32)),domain,[11n,22n,33n].map(verifyingKey),1_000_000n);
 const address=sampleContractAddress();
 let ctx=createCircuitContext(address,'00'.repeat(32),init.currentContractState,{});
 const nonce=Buffer.alloc(32,8),id=Buffer.from(pureCircuits.redemptionId(nonce)),to=new Address(0,Buffer.alloc(32,12));
 const receipt=Buffer.alloc(32,3),holder={bytes:Buffer.alloc(32,4)},digest=pureCircuits.claimDigest(domain,Buffer.from(address,'hex'),receipt,0n,500n,holder);
 ctx=c.impureCircuits.claim(ctx,receipt,0n,500n,holder,0n,2n,signClaim(digest,11n),signClaim(digest,33n)).context;
 ctx=c.impureCircuits.redeem(ctx,nonce,0n,100n,to.hash).context;
 const raw=init.currentContractState as unknown as {data:unknown;serialize():Uint8Array};raw.data=ctx.currentQueryContext.state;
 const build=(authority=new ContractMaintenanceAuthority([],1),swap?:string)=>{
  const s=ContractState.deserialize(raw.serialize());
  for(const n of circuitNames){const op=new ContractOperation();op.verifierKey=readFileSync(`build/midnight/keys/${swap===n?'claim':n}.verifier`);s.setOperation(n,op);}
  s.maintenanceAuthority=authority;return s;
 };
 const state=build(),pins=statePins(state),escrows:[string,string]=[new Address(0,Buffer.alloc(32,1)).toRawString(),new Address(0,Buffer.alloc(32,2)).toRawString()];
 const request={id:id.toString('hex'),asset:0 as const,amount:'100',recipient:to.toRawString(),transactionId:'local'};
 assert(verifyRedemption(state,pins,request,escrows).equals(releaseDigest(Address.parse(escrows[0]),domain,id,100n,to)));
 assert.throws(()=>verifyRedemption(build(undefined,'redeem'),pins,request,escrows),/verifier/);
 assert.throws(()=>verifyRedemption(state,{...pins,domain:'00'.repeat(32)},request,escrows),/domain/);
 assert.throws(()=>verifyRedemption(state,{...pins,maintenanceHash:'00'.repeat(32)},request,escrows),/maintenance/);
 assert.throws(()=>verifyRedemption(state,pins,{...request,amount:'99'},escrows),/differs/);
});
