import {Address} from '@ton/core';
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
