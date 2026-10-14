import {Address,Cell} from '@ton/core';
import {isPending,type Entry} from './journal.js';
/** A new logical ID must not bypass an unresolved wallet sequence reservation. */
export function assertTonSendAvailable(entries:Entry[],wallet:string,seqno:number){
 if(!Number.isSafeInteger(seqno)||seqno<0)throw Error('Invalid wallet sequence');
 const expected=Address.parse(wallet);
 for(const row of entries){
  if(!isPending(row.stage))continue;
  const payload=JSON.parse(row.payload) as {wallet:string;seqno:number};
  if(!Number.isSafeInteger(payload.seqno)||payload.seqno<0)throw Error('Invalid journal sequence; reconcile before sending');
  if(!Address.parse(payload.wallet).equals(expected))continue;
  if(row.stage!=='submitted'||payload.seqno>=seqno)throw Error(`Unresolved wallet send ${row.id}; reconcile exact transaction before a new send`);
 }
}
/** Journal ID for a new attempt of a logical send. Retrying is allowed only after every
 * earlier attempt is a proven rejection; anything else must be reconciled first. */
export function nextAttemptId(get:(id:string)=>Entry|undefined,id:string,{afterConfirmed=false}={}){
 let attempt=id;
 // `afterConfirmed` is for callers holding on-chain proof that a confirmed earlier send
 // had no lasting effect (for example a release the escrow restored); unresolved attempts
 // still block.
 const settled=(stage:Entry['stage'])=>stage==='rejected'||(afterConfirmed&&stage==='confirmed');
 for(let n=2;get(attempt);n++){if(!settled(get(attempt)!.stage))throw new Error('Existing send attempt; reconcile exact transaction before retrying');attempt=`${id}#${n}`;}
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
/** Sequence number a signed v4 wallet message body commits to (signature, wallet id and
 * valid_until precede it). A successful message at that sequence means no other can run. */
export function walletMessageSeqno(body:Cell){const s=body.beginParse();if(s.remainingBits<512+96)return undefined;s.skip(512+64);return s.loadUint(32);}
/** Outcome for a journaled wallet send that the finalized history does not show executed.
 * `walletSeqno` must be read at the same finalized block as the scanned history, and
 * `superseded` means that history holds a different successful message at this sequence.
 * `headTime` (the RPC head's time) may run ahead of that block by less than
 * WALLET_EXPIRY_MARGIN, which keeps the expiry proof sound. */
export function classifyUnfoundSend(boc:string,journalSeqno:number,{walletSeqno,superseded,headTime}:{walletSeqno:number|undefined;superseded:boolean;headTime:number}):'expired'|'superseded'|'unresolved'{
 if(superseded)return 'superseded';
 if(walletSeqno!==undefined&&walletMessageExpired(boc,journalSeqno,walletSeqno,headTime))return 'expired';
 return 'unresolved';
}

