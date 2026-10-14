import {existsSync,mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeFileAtomic} from './environment.js';
import {HEX32,toJson} from './encoding.js';
import type {RedemptionRequest} from './redemptions.js';

/** Signed attestations, keyed by TON deposit receipt (`claims`) or Midnight redemption (`releases`). */
export type MailboxKind='claims'|'releases';
const kinds:MailboxKind[]=['claims','releases'];
const id32=(id:string)=>{if(!HEX32.test(id))throw new Error('mailbox id must be 32-byte hex');return id.toLowerCase();};
const slot=(signer:number)=>{if(!Number.isInteger(signer)||signer<0||signer>2)throw new Error('signer must be 0, 1 or 2');return signer;};

/** Shared directory through which signers publish attestations and users submit redemption
 * requests: `claims/<receipt>/<signer>.json`, `releases/<redemption>/<signer>.json` and
 * `requests/<redemption>.json`. Contents are public and untrusted: readers re-verify every
 * signature and request against the chains. Files are written atomically and never replaced,
 * so a later run cannot overwrite an attestation another process may be relaying. */
export class Mailbox {
 constructor(readonly root:string){for(const d of [...kinds,'requests'])mkdirSync(join(root,d),{recursive:true,mode:0o755});}
 private file(kind:MailboxKind,id:string,signer:number){return join(this.root,kind,id32(id),`${slot(signer)}.json`);}
 has(kind:MailboxKind,id:string,signer:number){return existsSync(this.file(kind,id,signer));}
 /** Publishes one signer's attestation; an existing file is kept. Returns whether it wrote. */
 post(kind:MailboxKind,id:string,signer:number,value:unknown){
  const path=this.file(kind,id,signer);if(existsSync(path))return false;
  mkdirSync(join(this.root,kind,id32(id)),{recursive:true,mode:0o755});writeFileAtomic(path,toJson(value)+'\n',0o644);return true;
 }
 /** Every parseable attestation per id. Malformed files are skipped. */
 entries(kind:MailboxKind){
  const out=new Map<string,unknown[]>();
  for(const id of readdirSync(join(this.root,kind))){
   if(!HEX32.test(id))continue;const list:unknown[]=[];
   for(const f of readdirSync(join(this.root,kind,id)))if(/^[012]\.json$/.test(f)){try{list.push(JSON.parse(readFileSync(join(this.root,kind,id,f),'utf8')));}catch{/* partial or corrupt */}}
   out.set(id.toLowerCase(),list);
  }
  return out;
 }
 /** Queues a redemption for the signers. Only its shape is checked here. */
 submitRequest(request:RedemptionRequest){
  const r=parseRequest(request),path=join(this.root,'requests',`${r.id}.json`);
  if(existsSync(path)){if(JSON.stringify(parseRequest(JSON.parse(readFileSync(path,'utf8'))))!==JSON.stringify(r))throw new Error('a different request is already queued for this redemption');return false;}
  writeFileAtomic(path,JSON.stringify(r)+'\n',0o644);return true;
 }
 requests(){
  const out:RedemptionRequest[]=[];
  for(const f of readdirSync(join(this.root,'requests'))){
   if(!/^[0-9a-f]{64}\.json$/.test(f))continue;
   try{const r=parseRequest(JSON.parse(readFileSync(join(this.root,'requests',f),'utf8')));if(`${r.id}.json`===f)out.push(r);}catch{/* malformed */}
  }
  return out;
 }
}
/** A redemption request with exactly the expected fields. */
export function parseRequest(v:unknown):RedemptionRequest{
 const r=v as RedemptionRequest;
 if(!r||typeof r!=='object')throw new Error('request must be an object');
 if(typeof r.id!=='string'||!HEX32.test(r.id))throw new Error('request id must be 32-byte hex');
 if(r.asset!==0&&r.asset!==1)throw new Error('request asset must be 0 or 1');
 if(typeof r.amount!=='string'||!/^[1-9][0-9]{0,19}$/.test(r.amount))throw new Error('request amount must be a positive decimal string');
 if(typeof r.recipient!=='string'||typeof r.transactionId!=='string'||!r.transactionId)throw new Error('request recipient and transactionId are required');
 return {id:r.id.toLowerCase(),asset:r.asset,amount:r.amount,recipient:r.recipient,transactionId:r.transactionId};
}
