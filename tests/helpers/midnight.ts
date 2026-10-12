import {createConstructorContext,createCircuitContext,sampleContractAddress,type CircuitContext} from '@midnight-ntwrk/compact-runtime';
import {Contract,ledger,pureCircuits,type Witnesses} from '../../build/midnight/contract/index.js';
import {verifyingKey,signClaim,witnesses} from '../../src/midnight.js';

/** Midnight committee secrets used by every test (signers 0, 1, 2). */
export const MIDNIGHT_SECRETS=[11n,22n,33n] as const;
export const midnightCommittee=()=>MIDNIGHT_SECRETS.map(verifyingKey) as [ReturnType<typeof verifyingKey>,ReturnType<typeof verifyingKey>,ReturnType<typeof verifyingKey>];
export type Ctx=CircuitContext<Record<string,never>>;
export type Midnight=ReturnType<typeof deployMidnight>;
/** Fresh in-memory bridge contract; `context` is mutable so circuit results can be chained. */
export function deployMidnight({domain=Buffer.alloc(32,22),cap=1_000_000n}:{domain?:Buffer;cap?:bigint}={}){
 const contract=new Contract(witnesses),address=sampleContractAddress(),addressBytes=Buffer.from(address,'hex');
 const initial=contract.initialState(createConstructorContext({},'00'.repeat(32)),domain,midnightCommittee(),cap);
 let context:Ctx=createCircuitContext(address,'00'.repeat(32),initial.currentContractState,{});
 return {contract,circuits:contract.impureCircuits,domain,address,addressBytes,initial,
  get context(){return context;},set context(c:Ctx){context=c;},get state(){return ledger(context.currentQueryContext.state);}};
}
/** Contract with substituted (possibly dishonest) witnesses, to run against a deployment's context. */
export const contractWith=(w:Partial<Witnesses<Record<string,never>>>)=>new Contract({...witnesses,...w});
/** Claim digest for this deployment; `domain` and `address` may be overridden to model a wrong route. */
export const claimDigest=(m:Midnight,receipt:Uint8Array,asset:bigint,amount:bigint,recipient:{bytes:Uint8Array},domain:Uint8Array=m.domain,address:Uint8Array=m.addressBytes)=>pureCircuits.claimDigest(domain,address,receipt,asset,amount,recipient);
/** Signatures of signers 0 and 2 over a claim digest for this deployment. */
export function claimSignatures(...args:Parameters<typeof claimDigest>){
 const d=claimDigest(...args);return [signClaim(d,MIDNIGHT_SECRETS[0]),signClaim(d,MIDNIGHT_SECRETS[2])] as const;
}
/** Applies a valid 0+2 quorum claim to the deployment. */
export function claimQuorum(m:Midnight,receipt:Uint8Array,asset:bigint,amount:bigint,recipient:{bytes:Uint8Array}){
 const [a,b]=claimSignatures(m,receipt,asset,amount,recipient);m.context=m.circuits.claim(m.context,receipt,asset,amount,recipient,0n,2n,a,b).context;return m;
}
