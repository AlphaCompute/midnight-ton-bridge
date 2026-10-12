import {chmodSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
export type Stage='observed'|'prepared'|'sending'|'submitted'|'confirmed'|'rejected';
export type Entry={id:string;payload:string;stage:Stage;transaction:string|null;txid:string|null;error:string|null};
/** Stages whose transaction may still execute; they block new sends until reconciled. */
export const PENDING_STAGES:readonly Stage[]=['prepared','sending','submitted'];
export const isPending=(stage:Stage)=>PENDING_STAGES.includes(stage);
const TRANSITIONS:Record<Stage,readonly Stage[]>={observed:['prepared','rejected'],prepared:['sending','rejected'],sending:['submitted','confirmed','rejected'],submitted:['confirmed','rejected'],confirmed:[],rejected:[]};
const COLUMNS='id,payload,stage,tx AS "transaction",txid,error';

/** Owner-only SQLite database with WAL and full fsync, for records that must survive crashes. */
export function openDurableDb(path:string){
 const db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');return db;
}
/** Single durable source of truth for outgoing transactions. A crash in `sending`
 * requires reconciliation, never constructing or blindly sending a replacement. */
export class Journal {
 private db:DatabaseSync;
 constructor(path:string){
  this.db=openDurableDb(path);this.db.exec('CREATE TABLE IF NOT EXISTS transfers(id TEXT PRIMARY KEY,payload TEXT NOT NULL,stage TEXT NOT NULL,tx TEXT,txid TEXT,error TEXT);');
 }
 close(){this.db.close();}
 get(id:string):Entry|undefined{return this.db.prepare(`SELECT ${COLUMNS} FROM transfers WHERE id=?`).get(id) as Entry|undefined;}
 list(){return this.db.prepare(`SELECT ${COLUMNS} FROM transfers ORDER BY id`).all() as Entry[];}
 pending(){return this.list().filter(r=>isPending(r.stage));}
 observe(id:string,payload:string){
  this.db.prepare("INSERT OR IGNORE INTO transfers(id,payload,stage) VALUES(?,?,'observed')").run(id,payload);
  const found=this.get(id)!;if(found.payload!==payload)throw new Error('conflicting payload for receipt');return found;
 }
 /** Compare-and-set transition; `tx` and `txid` are kept unless replaced. */
 move(id:string,from:Stage,to:Stage,{tx=null,txid=null,error=null}:{tx?:string|null;txid?:string|null;error?:string|null}={}){
  if(!TRANSITIONS[from].includes(to))throw new Error('invalid transition');
  if(to==='prepared'&&(!tx||!txid))throw new Error('prepared transaction required');
  const result=this.db.prepare('UPDATE transfers SET stage=?,tx=COALESCE(?,tx),txid=COALESCE(?,txid),error=? WHERE id=? AND stage=?').run(to,tx,txid,error,id,from);
  if(result.changes!==1)throw new Error('transition lost race or wrong state');return this.get(id)!;
 }
}
