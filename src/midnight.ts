import {randomBytes} from 'node:crypto';
import {ecMulGenerator,ecMul,ecAdd,transientHash,upgradeFromTransient,CompactTypeVector,CompactTypeField,degradeToTransient,type JubjubPoint} from '@midnight-ntwrk/compact-runtime';

// Prime-order subgroup of Jubjub. Schnorr transcript matches bridge.compact.
export const JUBJUB_ORDER=6554484396890773809930967563523245729705921265872317281365359162392183254199n;
export type SchnorrSignature={announcement:JubjubPoint;response:bigint};
/** The bridge contract's on-chain operations. */
export const circuitNames=['claim','redeem','addLiquidity','swap','removeLiquidity'] as const;
export type CircuitName=typeof circuitNames[number];
/** Pool fee retained on every swap, in basis points; matches bridge.compact. */
export const SWAP_FEE_BPS=30n;
/** Uniform nonzero Jubjub scalar: a signing key or a Schnorr nonce. */
export function newSigningKey():bigint {
  for(;;){const n=BigInt('0x'+randomBytes(32).toString('hex'));if(n>0n&&n<JUBJUB_ORDER)return n;}
}
export function verifyingKey(secret:bigint) {if(secret<=0n||secret>=JUBJUB_ORDER)throw new Error('invalid signing scalar');return ecMulGenerator(secret);}
function challenge(digest:Uint8Array,r:JubjubPoint,p:JubjubPoint) {
  const hash=upgradeFromTransient(transientHash(new CompactTypeVector(5,CompactTypeField),[r.x,r.y,p.x,p.y,degradeToTransient(digest)]));
  return BigInt('0x'+Buffer.from(hash.slice(0,31)).reverse().toString('hex'));
}
export function signClaim(digest:Uint8Array,secret:bigint):SchnorrSignature {
  if(digest.length!==32)throw new Error('invalid digest');
  const pk=verifyingKey(secret),nonce=newSigningKey(),announcement=ecMulGenerator(nonce);
  return {announcement,response:(nonce+challenge(digest,announcement,pk)*secret)%JUBJUB_ORDER};
}
let IDENTITY:JubjubPoint|undefined;
const identity=()=>IDENTITY??=ecMulGenerator(0n);
/** Non-identity point in the prime-order subgroup. */
export function validPoint(p:JubjubPoint):boolean {
 try {const id=identity();if(p.x===id.x&&p.y===id.y)return false;const check=ecAdd(ecMul(p,JUBJUB_ORDER-1n),p);return check.x===id.x&&check.y===id.y;}catch{return false;}
}
export function verifyClaim(digest:Uint8Array,pk:JubjubPoint,sig:SchnorrSignature):boolean {
  try {
    if(!validPoint(pk)||!validPoint(sig.announcement)||digest.length!==32||sig.response<0n||sig.response>=JUBJUB_ORDER)return false;
    const lhs=ecMulGenerator(sig.response),rhs=ecAdd(sig.announcement,ecMul(pk,challenge(digest,sig.announcement,pk)));
    return lhs.x===rhs.x&&lhs.y===rhs.y;
  } catch{return false;}
}
type Empty=Record<string,never>;
/** Untrusted private-state helpers; bridge.compact constrains every result. */
export const witnesses={
  scalarParts:({privateState}:{privateState:Empty},value:bigint):[Empty,[bigint,bigint]]=>[privateState,[value>>248n,value&((1n<<248n)-1n)]],
  quotient:({privateState}:{privateState:Empty},n:bigint,d:bigint):[Empty,bigint]=>{if(d<=0n)throw new Error('division by zero');return [privateState,n/d];},
};

export function quoteSwap(input:bigint,reserveIn:bigint,reserveOut:bigint):bigint {
  if(input<=0n||reserveIn<=0n||reserveOut<=0n)throw new Error('invalid quote');
  const net=input*(10000n-SWAP_FEE_BPS),out=net*reserveOut/(reserveIn*10000n+net);
  if(out===0n)throw new Error('amount below pool precision');return out;
}
