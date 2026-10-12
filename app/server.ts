import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extname,join,normalize} from 'node:path';
import {Address} from '@ton/core';
import {DEPOSIT_ATTACHED_TON,transferBody} from '../src/ton.js';
import {SWAP_FEE_BPS,quoteSwap} from '../src/midnight.js';
import {TON_FINALITY_DEPTH} from '../src/ton-network.js';
import type {DepositReceipt} from '../src/escrow.js';
import {midnightIndexer,redactEndpoints} from '../src/midnight-endpoints.js';
import {jettonWalletOf,loadDeployment,midnightIndexerReader,tonRpcReader,type Deployment,type MidnightReader,type TonReader} from './readers.js';
import {HttpError,formatUnits,parseMidnightRecipient,parseTonAddress,parseUnits,routeFor} from './parse.js';

const PUBLIC=fileURLToPath(new URL('./public/',import.meta.url));
const TYPES:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const MAX_BODY=8192;
const friendly=(a:Address)=>a.toString({testOnly:true,bounceable:true,urlSafe:true});
const hostOf=(origin:string)=>{try{return new URL(origin).host;}catch{return undefined;}};
type Route={run:(q:URLSearchParams,body:Record<string,unknown>)=>Promise<unknown>;unthrottled?:true};

export function createApp(options:{deployment:Deployment;ton:TonReader;midnight?:MidnightReader|undefined;midnightUnavailable?:string;cacheMs?:number;maxInFlight?:number}){
 const {deployment:d,ton}=options,cacheMs=options.cacheMs??10000,maxInFlight=options.maxInFlight??32;
 const escrows=d.assets.map(a=>Address.parse(a.escrow)),attachedTon=formatUnits(DEPOSIT_ATTACHED_TON,9);
 // Every API route except config reaches the TON or Midnight RPC; cap concurrent ones so
 // a single client cannot use this server to flood those upstream endpoints.
 let inFlight=0;
 const cache=new Map<string,{at:number;value:Promise<unknown>}>();
 const cached=<T>(key:string,load:()=>Promise<T>):Promise<T>=>{const hit=cache.get(key);if(hit&&Date.now()-hit.at<cacheMs)return hit.value as Promise<T>;
  const value=load();cache.set(key,{at:Date.now(),value});value.catch(()=>cache.delete(key));return value;};
 const midnight=async()=>{if(!options.midnight)throw new HttpError(503,options.midnightUnavailable??'Midnight indexer not configured');
  try{return await cached('midnight',()=>options.midnight!.snapshot());}catch{throw new HttpError(502,'Midnight indexer unavailable');}};
 const tonStatus=async()=>{try{return await cached('ton',()=>ton.status());}catch{throw new HttpError(502,'TON testnet RPC unavailable');}};
 const config={network:d.network,domain:d.domain,midnight:d.midnight,attachedTon,confirmations:TON_FINALITY_DEPTH,
  assets:d.assets.map((a,i)=>({asset:a.asset,symbol:a.symbol,decimals:a.decimals,master:friendly(Address.parse(a.master)),escrow:friendly(escrows[i]!),cap:a.cap,walletCodeHash:a.walletCodeHash,escrowCodeHash:a.codeHash}))};

 const routes:Record<string,Route>={
  'GET /api/config':{unthrottled:true,run:async()=>config},
  'GET /api/status':{run:async()=>{
   const [t,m]=await Promise.allSettled([tonStatus(),midnight()]);
   return {ton:t.status==='fulfilled'?{available:true,...t.value}:{available:false,error:(t.reason as Error).message},
    midnight:m.status==='fulfilled'?{available:true,reserve:m.value.reserve.map(String),circulating:m.value.circulating.map(String),totalShares:String(m.value.totalShares)}:{available:false,error:(m.reason as Error).message}};}},
  'GET /api/balances':{run:async q=>{const owner=parseTonAddress(q.get('owner'));
   return {owner:friendly(owner),assets:await Promise.all(d.assets.map(async a=>{const wallet=jettonWalletOf(a,owner);
    let balance:bigint|null;try{balance=await ton.balance(wallet);}catch{throw new HttpError(502,'TON testnet RPC unavailable');}
    return {asset:a.asset,wallet:friendly(wallet),balance:balance===null?null:String(balance)};}))};}},
  'POST /api/deposit':{run:async(_q,b)=>{
   const a=routeFor(d,b.asset),owner=parseTonAddress(b.tonAddress),units=parseUnits(b.amount,a.decimals),recipient=parseMidnightRecipient(b.midnightRecipient);
   const wallet=jettonWalletOf(a,owner),escrow=escrows[a.asset]!,warnings:string[]=[];
   try{const s=await tonStatus(),locked=BigInt(s.assets[a.asset]!.locked);if(locked+units>BigInt(a.cap))throw new HttpError(400,`Deposit would exceed the route cap (${formatUnits(BigInt(a.cap)-locked,a.decimals)} ${a.symbol} remaining)`);}
   catch(e){if(e instanceof HttpError&&e.status===400)throw e;warnings.push('Capacity unchecked');}
   try{const bal=await ton.balance(wallet);if(bal===null||bal<units)throw new HttpError(400,`Insufficient ${a.symbol}: wallet holds ${formatUnits(bal??0n,a.decimals)}`);}
   catch(e){if(e instanceof HttpError&&e.status===400)throw e;warnings.push('Balance unchecked');}
   const queryId=randomBytes(8).readBigUInt64BE()>>1n,boc=transferBody(queryId,units,escrow,owner,recipient).toBoc();
   const payload=boc.toString('base64'),to=friendly(wallet),attached=DEPOSIT_ATTACHED_TON.toString();
   return {asset:a.asset,symbol:a.symbol,amount:formatUnits(units,a.decimals),units:String(units),from:friendly(owner),jettonWallet:to,escrow:friendly(escrow),
    midnightRecipient:recipient.toString('hex'),queryId:String(queryId),attachedTon,payload,warnings,
    tonConnect:{validUntil:Math.floor(Date.now()/1000)+600,network:'-3',messages:[{address:to,amount:attached,payload}]},
    deepLink:`ton://transfer/${to}?amount=${attached}&bin=${encodeURIComponent(boc.toString('base64url'))}`};}},
  'GET /api/receipt':{run:async q=>{
   const a=routeFor(d,q.get('asset')),raw=q.get('sequence')??'';if(!/^\d{1,19}$/.test(raw))throw new HttpError(400,'Sequence must be a non-negative integer');
   let receipt:DepositReceipt;
   try{receipt=await ton.receipt(a,BigInt(raw));}catch(e){const m=(e as Error).message;
    if(m==='deposit not found')throw new HttpError(404,`No finalized deposit #${raw} on the ${a.symbol} escrow yet`);throw new HttpError(502,`TON lookup failed: ${m}`);}
   let claimed:boolean|null=null,midnightNote:string|undefined;
   try{claimed=(await midnight()).claimed(receipt.id);}catch(e){midnightNote=(e as Error).message;}
   return {...receipt,symbol:a.symbol,display:formatUnits(BigInt(receipt.amount),a.decimals),claimed,midnightNote};}},
  'POST /api/quote':{run:async(_q,b)=>{
   const a=routeFor(d,b.assetIn),out=d.assets[1-a.asset]!,units=parseUnits(b.amount,a.decimals);
   const slip=Number(b.slippageBps??50);if(!Number.isInteger(slip)||slip<0||slip>5000)throw new HttpError(400,'Slippage must be 0–5000 bps');
   const m=await midnight(),rin=m.reserve[a.asset],rout=m.reserve[out.asset];if(!rin||!rout)throw new HttpError(409,'The pool has no liquidity yet');
   let quoted:bigint;try{quoted=quoteSwap(units,rin,rout);}catch(e){throw new HttpError(400,(e as Error).message);}
   const minOut=quoted*BigInt(10000-slip)/10000n,spot=Number(rout)/Number(rin),impact=1-Number(quoted)/(Number(units)*spot*(1-Number(SWAP_FEE_BPS)/10000));
   return {in:formatUnits(units,a.decimals),out:formatUnits(quoted,out.decimals),outUnits:String(quoted),minOut:formatUnits(minOut,out.decimals),minOutUnits:String(minOut),
    priceImpact:Math.max(0,impact),fee:formatUnits(units*SWAP_FEE_BPS/10000n,a.decimals),symbolIn:a.symbol,symbolOut:out.symbol};}},
 };

 const readJson=async(req:IncomingMessage)=>{
  if(!String(req.headers['content-type']).startsWith('application/json'))throw new HttpError(415,'JSON body required');
  const origin=req.headers.origin,host=req.headers.host;if(origin&&host&&hostOf(origin)!==host)throw new HttpError(403,'Cross-origin request rejected');
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req as AsyncIterable<Buffer>){size+=chunk.length;if(size>MAX_BODY)throw new HttpError(413,'Body too large');chunks.push(chunk);}
  let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new HttpError(400,'Malformed JSON');}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new HttpError(400,'JSON object required');
  return body as Record<string,unknown>;
 };
 return createServer(async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  const json=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  try{
   const url=new URL(req.url??'/','http://localhost'),route=routes[`${req.method} ${url.pathname}`];
   if(route){
    const body=req.method==='POST'?await readJson(req):{};
    if(route.unthrottled){json(200,await route.run(url.searchParams,body));return;}
    if(inFlight>=maxInFlight)throw new HttpError(503,'Server busy; retry shortly');
    inFlight++;try{json(200,await route.run(url.searchParams,body));}finally{inFlight--;}return;
   }
   if(url.pathname.startsWith('/api/'))throw new HttpError(404,'Not found');
   if(req.method!=='GET'&&req.method!=='HEAD')throw new HttpError(405,'Method not allowed');
   const file=normalize(join(PUBLIC,url.pathname==='/'?'index.html':url.pathname));
   if(!file.startsWith(PUBLIC)||!TYPES[extname(file)])throw new HttpError(404,'Not found');
   let content:Buffer;try{content=readFileSync(file);}catch{throw new HttpError(404,'Not found');}
   res.writeHead(200,{'content-type':TYPES[extname(file)]!,'cache-control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
  }catch(e){
   if(e instanceof HttpError){json(e.status,{error:e.message});return;}
   // Unexpected errors may carry upstream URLs or internals; log them, never echo them.
   console.error(e);json(500,{error:'Internal error'});
  }
 });
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const deployment=loadDeployment(process.env.BRIDGE_DEPLOYMENT_FILE??fileURLToPath(new URL('../docs/evidence/testnet-deployment.json',import.meta.url)));
 // Preprod is served by Blockfrost: BLOCKFROST_PROJECT_ID, or an explicit MIDNIGHT_INDEXER_URL.
 let midnight:MidnightReader|undefined,midnightUnavailable='Midnight indexer not configured (set BLOCKFROST_PROJECT_ID or MIDNIGHT_INDEXER_URL)';
 if(process.env.BLOCKFROST_PROJECT_ID||process.env.MIDNIGHT_INDEXER_URL){
  try{midnight=await midnightIndexerReader(deployment,midnightIndexer('preprod'));}
  catch(e){midnightUnavailable=`Midnight indexer misconfigured: ${redactEndpoints((e as Error).message)}`;console.error(midnightUnavailable);}
 }
 const port=Number(process.env.PORT??3080),host=process.env.HOST??'127.0.0.1';
 createApp({deployment,ton:tonRpcReader(deployment),midnight,midnightUnavailable}).listen(port,host,()=>console.log(`Bridge app: http://${host}:${port}`));
}
