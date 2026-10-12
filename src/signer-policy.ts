import {existsSync} from 'node:fs';
import {openDurableDb} from './journal.js';
export type SigningPolicy={maxTransfer:string;maxPerDay:string;stopFile:string;database:string};
/** Reserve quota and bind an immutable payload before exposing a signature.
 * Retries of the identical payload consume no additional quota. */
export function authorizeSignature(policy:SigningPolicy,id:string,payload:string,amount:bigint,now=Date.now()){
 if(!policy||!policy.stopFile||!policy.database)throw new Error('signer policy is required');
 if(existsSync(policy.stopFile))throw new Error('signing paused by stop file');
 const cap=BigInt(policy.maxTransfer),daily=BigInt(policy.maxPerDay);if(amount<=0n||cap<=0n||daily<cap||amount>cap)throw new Error('transfer exceeds signer policy');
 const db=openDurableDb(policy.database);
 try{
  db.exec('CREATE TABLE IF NOT EXISTS signed(id TEXT PRIMARY KEY,payload TEXT NOT NULL,amount TEXT NOT NULL,day TEXT NOT NULL); BEGIN IMMEDIATE');
  const row=db.prepare('SELECT payload FROM signed WHERE id=?').get(id) as {payload:string}|undefined;
  if(row){if(row.payload!==payload)throw new Error('refusing conflicting attestation');db.exec('COMMIT');return;}
  const day=new Date(now).toISOString().slice(0,10),rows=db.prepare('SELECT amount FROM signed WHERE day=?').all(day) as {amount:string}[];
  if(rows.reduce((n,r)=>n+BigInt(r.amount),0n)+amount>daily)throw new Error('daily signing limit exceeded');
  db.prepare('INSERT INTO signed VALUES(?,?,?,?)').run(id,payload,amount.toString(),day);db.exec('COMMIT');
 }finally{db.close();}
}
