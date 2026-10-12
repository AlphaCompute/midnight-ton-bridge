import {Address,Cell} from '@ton/core';
import type {Entry} from './journal.js';
/** A new logical ID must not bypass an unresolved wallet sequence reservation. */
export function assertTonSendAvailable(entries:Entry[],wallet:string,seqno:number){
 if(!Number.isSafeInteger(seqno)||seqno<0)throw Error('Invalid wallet sequence');
 const expected=Address.parse(wallet);
 for(const row of entries){
  if(!['prepared','sending','submitted'].includes(row.stage))continue;
  const payload=JSON.parse(row.payload) as {wallet:string;seqno:number};
  if(!Number.isSafeInteger(payload.seqno)||payload.seqno<0)throw Error('Invalid journal sequence; reconcile before sending');
  if(!Address.parse(payload.wallet).equals(expected))continue;
  if(row.stage!=='submitted'||payload.seqno>=seqno)throw Error(`Unresolved wallet send ${row.id}; reconcile exact transaction before a new send`);
 }
}
/** Journal ID for a new attempt of a logical send. Retrying is allowed only after every
 * earlier attempt is a proven rejection; anything else must be reconciled first. */
export function nextAttemptId(get:(id:string)=>Entry|undefined,id:string){
 let attempt=id;
 for(let n=2;get(attempt);n++){if(get(attempt)!.stage!=='rejected')throw new Error('Existing send attempt; reconcile exact transaction before retrying');attempt=`${id}#${n}`;}
 return attempt;
}
/** Seconds beyond valid_until before a finalized block time proves expiry; covers
 * shard/masterchain clock skew. */
export const WALLET_EXPIRY_MARGIN=60;
/** A signed v4 wallet message can never execute once a finalized block, timed after
 * its valid_until, still shows the wallet at that unconsumed sequence. Any other
 * outcome, including an advanced sequence without a located transaction, stays
 * unresolved. */
export function walletMessageExpired(boc:string,journalSeqno:number,walletSeqno:number,blockTime:number){
 if(!Number.isSafeInteger(journalSeqno)||!Number.isSafeInteger(walletSeqno)||!Number.isSafeInteger(blockTime))throw Error('Invalid expiry evidence');
 const body=Cell.fromBase64(boc).beginParse();body.skip(512+32);
 const validUntil=body.loadUint(32),signedSeqno=body.loadUint(32);
 if(signedSeqno!==journalSeqno)throw Error('Journal sequence does not match the signed wallet message');
 return walletSeqno===journalSeqno&&blockTime>validUntil+WALLET_EXPIRY_MARGIN;
}
