import {randomBytes} from 'node:crypto';
import {ecMulGenerator,ecMul,ecAdd,transientHash,upgradeFromTransient,CompactTypeVector,CompactTypeField,degradeToTransient,type JubjubPoint} from '@midnight-ntwrk/compact-runtime';

// Prime-order subgroup of Jubjub. Schnorr transcript matches bridge.compact.
export const JUBJUB_ORDER=6554484396890773809930967563523245729705921265872317281365359162392183254199n;
export type SchnorrSignature={announcement:JubjubPoint;response:bigint};
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
export function verifyClaim(digest:Uint8Array,pk:JubjubPoint,sig:SchnorrSignature):boolean {
  try {
    if(digest.length!==32||sig.response<0n||sig.response>=JUBJUB_ORDER)return false;
    const lhs=ecMulGenerator(sig.response),rhs=ecAdd(sig.announcement,ecMul(pk,challenge(digest,sig.announcement,pk)));
    return lhs.x===rhs.x&&lhs.y===rhs.y;
  } catch{return false;}
}
export const witnesses={quotient:({privateState}: {privateState:Record<string,never>},n:bigint,d:bigint):[Record<string,never>,bigint]=>{
  if(d<=0n)throw new Error('division by zero');return [privateState,n/d];
}};

export function quoteSwap(input:bigint,reserveIn:bigint,reserveOut:bigint):bigint {
  if(input<=0n||reserveIn<=0n||reserveOut<=0n)throw new Error('invalid quote');
  const out=input*9970n*reserveOut/(reserveIn*10000n+input*9970n);
  if(out===0n)throw new Error('amount below pool precision');return out;
}
