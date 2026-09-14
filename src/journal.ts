import {DatabaseSync} from 'node:sqlite';
export type Stage='observed'|'prepared'|'sending'|'submitted'|'confirmed'|'rejected';
export type Entry={id:string;payload:string;stage:Stage;transaction:string|null;txid:string|null;error:string|null};

/** Single durable source of truth. A crash in `sending` requires reconciliation,
 * never constructing or blindly sending a replacement transaction. */
export class Journal {
 private db:DatabaseSync;
 constructor(path:string){
  this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS transfers(id TEXT PRIMARY KEY,payload TEXT NOT NULL,stage TEXT NOT NULL,tx TEXT,txid TEXT,error TEXT);');
 }
 close(){this.db.close();}
 get(id:string):Entry|undefined{return this.db.prepare('SELECT id,payload,stage,tx AS "transaction",txid,error FROM transfers WHERE id=?').get(id) as Entry|undefined;}
 observe(id:string,payload:string){
  this.db.prepare("INSERT OR IGNORE INTO transfers(id,payload,stage) VALUES(?,?,'observed')").run(id,payload);
  const found=this.get(id)!;if(found.payload!==payload)throw new Error('conflicting payload for receipt');return found;
 }
 move(id:string,from:Stage,to:Stage,tx:string|null=null,txid:string|null=null,error:string|null=null){
  const allowed:Record<Stage,Stage[]>={observed:['prepared','rejected'],prepared:['sending','rejected'],sending:['submitted','confirmed','rejected'],submitted:['confirmed','rejected'],confirmed:[],rejected:[]};
  if(!allowed[from].includes(to))throw new Error('invalid transition');
  if(to==='prepared'&&!tx)throw new Error('prepared transaction required');
  const result=this.db.prepare('UPDATE transfers SET stage=?,tx=COALESCE(?,tx),txid=COALESCE(?,txid),error=? WHERE id=? AND stage=?').run(to,tx,txid,error,id,from);
  if(result.changes!==1)throw new Error('transition lost race or wrong state');return this.get(id)!;
 }
 list(){return this.db.prepare('SELECT id,payload,stage,tx AS "transaction",txid,error FROM transfers ORDER BY id').all() as Entry[];}
}
export interface Destination {
 prepare(payload:string):Promise<{bytes:string;id:string}>;
 submit(bytes:string):Promise<void>;
 /** Must identify the exact stored transaction, not just account health. */
 reconcile(transactionId:string,bytes:string):Promise<'confirmed'|'rejected'|'pending'|'unknown'>;
}
export async function advance(j:Journal,id:string,d:Destination):Promise<Entry>{
 let row=j.get(id);if(!row)throw new Error('unknown transfer');
 if(row.stage==='observed') {const p=await d.prepare(row.payload);row=j.move(id,'observed','prepared',p.bytes,p.id);}
 if(row.stage==='prepared') {
  row=j.move(id,'prepared','sending');
  try{await d.submit(row.transaction!);row=j.move(id,'sending','submitted');}
  catch{return j.get(id)!;} // ambiguous submission: preserve bytes and state
 }
 if(row.stage==='sending'||row.stage==='submitted'){
  const result=await d.reconcile(row.txid!,row.transaction!);
  if(result==='confirmed'||result==='rejected')row=j.move(id,row.stage,result,null,null,result==='rejected'?'chain rejection':null);
 }
 return row;
}
