import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {Address} from '@ton/core';
import {ContractState,ContractOperation,ContractMaintenanceAuthority} from '@midnight-ntwrk/compact-runtime';
import {pureCircuits} from '../build/midnight/contract/index.js';
import {circuitNames} from '../src/midnight.js';
import {redemptionCommitment,statePins,verifyRedemption} from '../src/redemptions.js';
import {releaseDigest} from '../src/ton.js';
import {deployMidnight,claimQuorum} from './helpers/midnight.js';

const holder={bytes:Buffer.alloc(32,4)};

test('retirement records a commitment under a hashed ID; replays and front-running cannot touch it',()=>{
 const m=claimQuorum(deployMidnight(),Buffer.alloc(32,10),0n,10000n,holder),to=new Address(0,Buffer.alloc(32,12));
 const nonce=Buffer.alloc(32,88),id=Buffer.from(pureCircuits.redemptionId(nonce)),commitment=redemptionCommitment(0,100n,to);
 m.context=m.circuits.redeem(m.context,nonce,0n,100n,to.hash).context;
 assert.equal(m.state.circulating[0],9900n);
 assert.deepEqual(m.state.retired.lookup(id),commitment);assert(!m.state.retired.member(nonce));
 assert.throws(()=>m.circuits.redeem(m.context,nonce,0n,100n,to.hash),/replayed redemption/);
 // Only the hash is public: retiring with the observed ID as a nonce yields another ID,
 // so a front-runner cannot occupy or overwrite a pending redemption's ID.
 const attacker=new Address(0,Buffer.alloc(32,13));
 m.context=m.circuits.redeem(m.context,id,0n,50n,attacker.hash).context;
 assert.deepEqual(m.state.retired.lookup(id),commitment);
 assert.deepEqual(m.state.retired.lookup(Buffer.from(pureCircuits.redemptionId(id))),redemptionCommitment(0,50n,attacker));
 assert.equal(m.state.circulating[0],9850n);
});

const keyed=circuitNames.every(n=>existsSync(`build/midnight/keys/${n}.verifier`));
test('signer verification pins verifier keys, maintenance authority and domain before using a retirement',{skip:keyed?false:'requires npm run compile:midnight -- --proof'},()=>{
 const domain=Buffer.alloc(32,5),m=claimQuorum(deployMidnight({domain}),Buffer.alloc(32,3),0n,500n,holder);
 const nonce=Buffer.alloc(32,8),id=Buffer.from(pureCircuits.redemptionId(nonce)),to=new Address(0,Buffer.alloc(32,12));
 m.context=m.circuits.redeem(m.context,nonce,0n,100n,to.hash).context;
 const raw=m.initial.currentContractState as unknown as {data:unknown;serialize():Uint8Array};raw.data=m.context.currentQueryContext.state;
 /** On-chain state as an indexer would return it, optionally with another authority or a swapped verifier key. */
 const build=(authority=new ContractMaintenanceAuthority([],1),swap?:string)=>{
  const s=ContractState.deserialize(raw.serialize());
  for(const n of circuitNames){const op=new ContractOperation();op.verifierKey=readFileSync(`build/midnight/keys/${swap===n?'claim':n}.verifier`);s.setOperation(n,op);}
  s.maintenanceAuthority=authority;return s;
 };
 const state=build(),pins=statePins(state),escrows:[string,string]=[new Address(0,Buffer.alloc(32,1)).toRawString(),new Address(0,Buffer.alloc(32,2)).toRawString()];
 const request={id:id.toString('hex'),asset:0 as const,amount:'100',recipient:to.toRawString(),transactionId:'local'};
 assert(verifyRedemption(state,pins,request,escrows).equals(releaseDigest(Address.parse(escrows[0]),domain,id,100n,to)));
 assert.throws(()=>verifyRedemption(build(undefined,'redeem'),pins,request,escrows),/verifier/);
 assert.throws(()=>verifyRedemption(build(new ContractMaintenanceAuthority([],1,1n)),pins,request,escrows),/maintenance/);
 assert.throws(()=>verifyRedemption(state,{...pins,domain:'00'.repeat(32)},request,escrows),/domain/);
 assert.throws(()=>verifyRedemption(state,{...pins,maintenanceHash:'00'.repeat(32)},request,escrows),/maintenance/);
 assert.throws(()=>verifyRedemption(state,pins,{...request,amount:'99'},escrows),/differs/);
});
