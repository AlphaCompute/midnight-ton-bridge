import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {BridgeClient,DEPOSIT_ATTACHED_TON} from '@alphaton/midnight-ton-bridge/client';
import {fileURLToPath} from 'node:url';
// Bounded so a local client cannot grow process memory without limit.
export const MAX_NOTES=1000;
const ATTACHED_TON=(()=>{const s=DEPOSIT_ATTACHED_TON.toString().padStart(10,'0'),f=s.slice(-9).replace(/0+$/,'');return s.slice(0,-9)+(f?'.'+f:'');})();
export function start(port=3077,{maxNotes=MAX_NOTES}={}){
 const notes=new Map();let client;
 // Built on first use so the note flow works without BRIDGE_CONFIG.
 const bridge=()=>client??=(()=>{const config=JSON.parse(readFileSync(process.env.BRIDGE_CONFIG,'utf8'));
  config.committee=config.committee.map(p=>({x:BigInt(p.x),y:BigInt(p.y)}));
  return new BridgeClient(config,{call:async()=>{throw new Error('This starter never custodies a signing wallet');}});})();
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  try{
   if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(readFileSync(new URL('./index.html',import.meta.url)));return;}
   if(req.method!=='POST'){json(404,{error:'not found'});return;}
   const origin=req.headers.origin;if(origin&&origin!==`http://127.0.0.1:${server.address().port}`&&origin!==`http://localhost:${server.address().port}`){json(403,{error:'origin rejected'});return;}
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384){json(413,{error:'body too large'});return;}}
   const input=JSON.parse(body);
   if(req.url==='/notes'){
    if(typeof input.text!=='string'||input.text.length<1||input.text.length>8192){json(400,{error:'note must be 1–8192 characters'});return;}
    if(notes.size>=maxNotes){json(507,{error:'note storage full; restart to clear'});return;}
    const id=randomBytes(16).toString('hex'),opening=randomBytes(32),commitment=createHash('sha256').update(opening).update(input.text).digest('hex');
    // The opening is returned so the holder can later prove which text the commitment binds.
    const note={text:input.text,commitment,opening:opening.toString('hex')};notes.set(id,note);json(201,{id,commitment,opening:note.opening,storage:'local process memory; cleared on restart'});return;
   }
   if(req.url==='/notes/read'){json(notes.has(input.id)?200:404,notes.get(input.id)??{error:'unknown note'});return;}
   if(req.url==='/bridge/prepare'){
    if(!process.env.BRIDGE_CONFIG){json(503,{error:'Set BRIDGE_CONFIG to prepare test-token transfers'});return;}
    const queryId=randomBytes(8).readBigUInt64BE()>>1n,payload=bridge().depositMessage(input.asset,BigInt(input.amount),input.midnightRecipient,input.tonSender,queryId);
    json(200,{payload:payload.toBoc().toString('base64'),queryId:String(queryId),sendTo:'Your verified jetton wallet for this asset',attachedTON:ATTACHED_TON,network:'TON testnet',status:'unsigned; not submitted'});return;
   }
   json(404,{error:'not found'});
  }catch{json(400,{error:'Invalid request or bridge configuration'});}
 });
 server.listen(port,'127.0.0.1');return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){start(Number(process.env.PORT??3077));console.log(`Notes starter: http://127.0.0.1:${process.env.PORT??3077}`);}
