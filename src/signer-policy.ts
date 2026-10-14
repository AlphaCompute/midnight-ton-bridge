import {statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {openDurableDb} from './journal.js';
export type SigningPolicy={maxTransfer:string;maxPerDay:string;stopFile:string;database:string};
/** Reserve quota and bind an immutable payload before exposing a signature.
 * Retries of the identical payload consume no additional quota. */
export function authorizeSignature(policy:SigningPolicy,id:string,payload:string,amount:bigint,now=Date.now()){
 if(!policy||!policy.stopFile||!policy.database)throw new Error('signer policy is required');
 // Relative paths would follow the working directory: a different one would miss the stop
 // file and open a fresh database, bypassing quota and conflicting-attestation refusal.
 if(!isAbsolute(policy.stopFile)||!isAbsolute(policy.database))throw new Error('signer policy stopFile and database must be absolute paths');
 // Fail closed: anything but a definite "no such file" (for example a permission error) pauses signing.
 let stopped=true;
 try{statSync(policy.stopFile);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')stopped=false;}
 if(stopped)throw new Error('signing paused by stop file (present or unreadable)');
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
