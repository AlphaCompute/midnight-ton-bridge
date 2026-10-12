import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extname,join,normalize} from 'node:path';
import {Address,Cell,toNano} from '@ton/core';
import {TonClient4} from '@ton/ton';
import {MidnightBech32m,UnshieldedAddress} from '@midnight-ntwrk/wallet-sdk-address-format';
import {referenceWallet,validateAssets,type JettonAsset} from '../src/jettons.js';
import {transferBody,uint64} from '../src/ton.js';
import {quoteSwap} from '../src/midnight.js';
import {observeTon,type DepositReceipt} from '../src/receipts.js';
import {assertTonTestnet} from '../src/ton-network.js';

/** Public route description. Holds no keys; safe to serve to browsers. */
export type RouteAsset=JettonAsset&{escrow:string;codeHash:string;configHash:string};
export type Deployment={network:string;domain:string;midnight:string;assets:[RouteAsset,RouteAsset]};
export type TonStatus={block:number;assets:{asset:0|1;locked:string;deposits:string}[]};
export interface TonReader {
 status():Promise<TonStatus>;
 /** Jetton balance of a wallet, or null when the wallet is not deployed. */
 balance(wallet:Address):Promise<bigint|null>;
 receipt(route:RouteAsset,sequence:bigint):Promise<DepositReceipt>;
}
export type MidnightSnapshot={reserve:[bigint,bigint];circulating:[bigint,bigint];totalShares:bigint;claimed:(id:string)=>boolean};
export interface MidnightReader {snapshot():Promise<MidnightSnapshot>}

const CONFIRMATIONS=3;
/** TON attached to the sender's jetton wallet; covers the 0.01 TON forwarded to the escrow plus fees. */
export const DEPOSIT_ATTACHED_TON=toNano('0.1');
export function loadDeployment(path:string):Deployment{
 const raw=JSON.parse(readFileSync(path,'utf8'));
 const assets=validateAssets(raw.ton.map(({escrow:_e,codeHash:_c,configHash:_h,...a}:RouteAsset)=>a));
 const routes=assets.map((a,i)=>{const r=raw.ton[i];
  if(Address.parse(r.escrow).workChain!==0||!/^[a-f0-9]{64}$/.test(r.codeHash)||!/^[a-f0-9]{64}$/.test(r.configHash))throw new Error('invalid escrow route');
  return {...a,escrow:Address.parse(r.escrow).toRawString(),codeHash:r.codeHash,configHash:r.configHash};}) as [RouteAsset,RouteAsset];
 if(!/^[a-f0-9]{64}$/.test(raw.domain)||!/^[a-f0-9]{64}$/.test(raw.midnight))throw new Error('invalid deployment identity');
 return {network:raw.network,domain:raw.domain,midnight:raw.midnight,assets:routes};
}

export function liveTon(deployment:Deployment,endpoint=process.env.TON_RPC_URL??'https://testnet-v4.tonhubapi.com'):TonReader{
 const client=new TonClient4({endpoint,timeout:15000});
 const finalized=async()=>{const h=await client.getLastBlock();assertTonTestnet(h);
  if(Math.abs(Date.now()/1000-h.now)>120)throw new Error('stale TON RPC head');return h.last.seqno-CONFIRMATIONS;};
 const int=async(block:number,a:Address,m:string)=>{const r=await client.runMethod(block,a,m);if(r.exitCode!==0)throw new Error(`${m} failed`);return r.reader.readBigNumber();};
 return {
  async status(){const block=await finalized();
   const assets=await Promise.all(deployment.assets.map(async r=>{const e=Address.parse(r.escrow);
    const [locked,deposits]=await Promise.all([int(block,e,'locked'),int(block,e,'depositCount')]);
    return {asset:r.asset,locked:String(locked),deposits:String(deposits)};}));
   return {block,assets};},
  async balance(wallet){const block=await finalized(),a=await client.getAccount(block,wallet);
   if(a.account.state.type!=='active')return null;return int(block,wallet,'get_wallet_data');},
  receipt:(r,sequence)=>observeTon(client,{escrow:r.escrow,asset:r.asset,codeHash:r.codeHash,configHash:r.configHash,confirmationDepth:CONFIRMATIONS},sequence),
 };
}

/** Reads the bridge ledger from a Midnight indexer. The public preprod indexer was
 * decommissioned on 2026-10-09; set MIDNIGHT_INDEXER_URL to a replacement. */
export async function liveMidnight(deployment:Deployment,url:string,ws:string):Promise<MidnightReader>{
 const [{default:WebSocket},{setNetworkId},{indexerPublicDataProvider},{ledger}]=await Promise.all([
  import('ws'),import('@midnight-ntwrk/midnight-js-network-id'),import('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),import('../build/midnight/contract/index.js')]);
 setNetworkId('preprod');globalThis.WebSocket??=WebSocket as unknown as typeof globalThis.WebSocket;
 const provider=indexerPublicDataProvider(url,ws);
 return {async snapshot(){
  const state=await provider.queryContractState(deployment.midnight);if(!state)throw new Error('bridge contract not found on indexer');
  const l=ledger(state.data);
  return {reserve:[l.reserve[0]!,l.reserve[1]!],circulating:[l.circulating[0]!,l.circulating[1]!],totalShares:l.totalShares,claimed:id=>l.claimed.member(Buffer.from(id,'hex'))};
 }};
}

/** Decimal token amount to integer base units; rejects excess precision. */
export function toUnits(value:unknown,decimals:number):bigint{
 if(typeof value!=='string'||!/^\d+(\.\d+)?$/.test(value.trim()))throw new Error('Enter an amount like 12.5');
 const [whole,frac='']=value.trim().split('.');if(frac.length>decimals)throw new Error(`At most ${decimals} decimal places`);
 return uint64(BigInt(whole!)*10n**BigInt(decimals)+BigInt(frac.padEnd(decimals,'0')||'0'));
}
/** Accepts an unshielded preprod bech32m address or the raw 32-byte hex form. */
export function midnightRecipient(value:unknown):Buffer{
 if(typeof value!=='string')throw new Error('Midnight recipient required');const v=value.trim();
 if(/^[a-f0-9]{64}$/i.test(v))return Buffer.from(v,'hex');
 let parsed:MidnightBech32m;try{parsed=MidnightBech32m.parse(v);}catch{throw new Error('Midnight recipient must be an mn_addr_preprod… address or 32-byte hex');}
 if(parsed.type!=='addr')throw new Error('Use an unshielded Midnight address (mn_addr…), not a shielded or dust address');
 if(parsed.network!=='preprod')throw new Error('This route only accepts Midnight preprod addresses');
 return UnshieldedAddress.codec.decode('preprod',parsed).data;
}
function tonOwner(value:unknown){
 if(typeof value!=='string'||!value.trim())throw new Error('TON address required');
 let a:Address;try{a=Address.parse(value.trim());}catch{throw new Error('Not a valid TON address');}
 if(a.workChain!==0)throw new Error('Only basechain TON wallets are supported');return a;
}
const friendly=(a:Address)=>a.toString({testOnly:true,bounceable:true,urlSafe:true});
const asset=(d:Deployment,v:unknown)=>{const n=Number(v);if(n!==0&&n!==1)throw new Error('Unknown asset');return d.assets[n]!;};
const fmt=(units:bigint,decimals:number)=>{const s=units.toString().padStart(decimals+1,'0');const f=s.slice(-decimals).replace(/0+$/,'');return decimals?`${s.slice(0,-decimals)}${f?'.'+f:''}`:s;};

class HttpError extends Error{constructor(readonly status:number,message:string){super(message);}}
const PUBLIC=fileURLToPath(new URL('./public/',import.meta.url));
const TYPES:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};

export function createApp(options:{deployment:Deployment;ton:TonReader;midnight?:MidnightReader|undefined;midnightUnavailable?:string;cacheMs?:number}){
 const {deployment:d,ton}=options,cacheMs=options.cacheMs??10000;
 const cache=new Map<string,{at:number;value:Promise<unknown>}>();
 const cached=<T>(key:string,load:()=>Promise<T>):Promise<T>=>{const hit=cache.get(key);if(hit&&Date.now()-hit.at<cacheMs)return hit.value as Promise<T>;
  const value=load();cache.set(key,{at:Date.now(),value});value.catch(()=>cache.delete(key));return value;};
 const midnight=async()=>{if(!options.midnight)throw new HttpError(503,options.midnightUnavailable??'Midnight indexer not configured');
  try{return await cached('midnight',()=>options.midnight!.snapshot());}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(502,'Midnight indexer unavailable');}};
 const tonStatus=async()=>{try{return await cached('ton',()=>ton.status());}catch{throw new HttpError(502,'TON testnet RPC unavailable');}};

 const routes:Record<string,(q:URLSearchParams,body:Record<string,unknown>)=>Promise<unknown>>={
  'GET /api/config':async()=>({network:d.network,domain:d.domain,midnight:d.midnight,attachedTon:fmt(DEPOSIT_ATTACHED_TON,9),confirmations:CONFIRMATIONS,
   assets:d.assets.map(a=>({asset:a.asset,symbol:a.symbol,decimals:a.decimals,master:friendly(Address.parse(a.master)),escrow:friendly(Address.parse(a.escrow)),cap:a.cap,walletCodeHash:a.walletCodeHash,escrowCodeHash:a.codeHash}))}),
  'GET /api/status':async()=>{
   const [t,m]=await Promise.allSettled([tonStatus(),midnight()]);
   return {ton:t.status==='fulfilled'?{available:true,...t.value}:{available:false,error:(t.reason as Error).message},
    midnight:m.status==='fulfilled'?{available:true,reserve:m.value.reserve.map(String),circulating:m.value.circulating.map(String),totalShares:String(m.value.totalShares)}:{available:false,error:(m.reason as Error).message}};},
  'GET /api/balances':async q=>{const owner=tonOwner(q.get('owner'));
   return {owner:friendly(owner),assets:await Promise.all(d.assets.map(async a=>{
    const wallet=referenceWallet(owner,Address.parse(a.master),Cell.fromBase64(a.walletCodeBoc)).address;
    let balance:bigint|null;try{balance=await ton.balance(wallet);}catch{throw new HttpError(502,'TON testnet RPC unavailable');}
    return {asset:a.asset,wallet:friendly(wallet),balance:balance===null?null:String(balance)};}))};},
  'POST /api/deposit':async(_q,b)=>{
   const a=asset(d,b.asset),owner=tonOwner(b.tonAddress),units=toUnits(b.amount,a.decimals),recipient=midnightRecipient(b.midnightRecipient);
   const wallet=referenceWallet(owner,Address.parse(a.master),Cell.fromBase64(a.walletCodeBoc)).address;
   const warnings:string[]=[];
   try{const s=await tonStatus(),locked=BigInt(s.assets[a.asset]!.locked);if(locked+units>BigInt(a.cap))throw new HttpError(400,`Deposit would exceed the route cap (${fmt(BigInt(a.cap)-locked,a.decimals)} ${a.symbol} remaining)`);}
   catch(e){if(e instanceof HttpError&&e.status===400)throw e;warnings.push('Capacity unchecked');}
   try{const bal=await ton.balance(wallet);if(bal===null||bal<units)throw new HttpError(400,`Insufficient ${a.symbol}: wallet holds ${fmt(bal??0n,a.decimals)}`);}
   catch(e){if(e instanceof HttpError&&e.status===400)throw e;warnings.push('Balance unchecked');}
   const queryId=randomBytes(8).readBigUInt64BE()>>1n,body=transferBody(queryId,units,Address.parse(a.escrow),owner,recipient);
   const payload=body.toBoc().toString('base64'),to=friendly(wallet),attached=DEPOSIT_ATTACHED_TON.toString();
   return {asset:a.asset,symbol:a.symbol,amount:fmt(units,a.decimals),units:String(units),from:friendly(owner),jettonWallet:to,escrow:friendly(Address.parse(a.escrow)),
    midnightRecipient:recipient.toString('hex'),queryId:String(queryId),attachedTon:fmt(DEPOSIT_ATTACHED_TON,9),payload,warnings,
    tonConnect:{validUntil:Math.floor(Date.now()/1000)+600,network:'-3',messages:[{address:to,amount:attached,payload}]},
    deepLink:`ton://transfer/${to}?amount=${attached}&bin=${encodeURIComponent(body.toBoc().toString('base64url'))}`};},
  'GET /api/deposit':async q=>{
   const a=asset(d,q.get('asset')),raw=q.get('sequence')??'';if(!/^\d{1,19}$/.test(raw))throw new HttpError(400,'Sequence must be a non-negative integer');
   const sequence=BigInt(raw);let receipt:DepositReceipt;
   try{receipt=await ton.receipt(a,sequence);}catch(e){const m=(e as Error).message;
    if(m==='deposit not found')throw new HttpError(404,`No finalized deposit #${raw} on the ${a.symbol} escrow yet`);throw new HttpError(502,`TON lookup failed: ${m}`);}
   let claimed:boolean|null=null,midnightNote:string|undefined;
   try{claimed=(await midnight()).claimed(receipt.id);}catch(e){midnightNote=(e as Error).message;}
   return {...receipt,symbol:a.symbol,display:fmt(BigInt(receipt.amount),a.decimals),claimed,midnightNote};},
  'POST /api/quote':async(_q,b)=>{
   const a=asset(d,b.assetIn),out=d.assets[1-a.asset]!,units=toUnits(b.amount,a.decimals),m=await midnight();
   const rin=m.reserve[a.asset],rout=m.reserve[out.asset];if(!rin||!rout)throw new HttpError(409,'The pool has no liquidity yet');
   let quoted:bigint;try{quoted=quoteSwap(units,rin,rout);}catch(e){throw new HttpError(400,(e as Error).message);}
   const slip=Number(b.slippageBps??50);if(!Number.isInteger(slip)||slip<0||slip>5000)throw new HttpError(400,'Slippage must be 0–5000 bps');
   const spot=Number(rout)/Number(rin),impact=1-Number(quoted)/(Number(units)*spot*0.997);
   return {in:fmt(units,a.decimals),out:fmt(quoted,out.decimals),outUnits:String(quoted),minOut:fmt(quoted*BigInt(10000-slip)/10000n,out.decimals),
    minOutUnits:String(quoted*BigInt(10000-slip)/10000n),priceImpact:Math.max(0,impact),fee:fmt(units*3n/1000n,a.decimals),symbolIn:a.symbol,symbolOut:out.symbol};},
 };

 const server=createServer(async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  const url=new URL(req.url??'/','http://localhost');
  const json=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  try{
   const handler=routes[`${req.method} ${url.pathname}`];
   if(handler){
    let body:Record<string,unknown>={};
    if(req.method==='POST'){
     if(!String(req.headers['content-type']).startsWith('application/json'))throw new HttpError(415,'JSON body required');
     const host=req.headers.host;if(req.headers.origin&&host&&new URL(req.headers.origin).host!==host)throw new HttpError(403,'Cross-origin request rejected');
     let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192)throw new HttpError(413,'Body too large');}
     try{body=JSON.parse(raw||'{}');}catch{throw new HttpError(400,'Malformed JSON');}
     if(!body||typeof body!=='object'||Array.isArray(body))throw new HttpError(400,'JSON object required');
    }
    json(200,await handler(url.searchParams,body));return;
   }
   if(url.pathname.startsWith('/api/'))throw new HttpError(404,'Not found');
   if(req.method!=='GET'&&req.method!=='HEAD')throw new HttpError(405,'Method not allowed');
   const file=normalize(join(PUBLIC,url.pathname==='/'?'index.html':url.pathname));
   if(!file.startsWith(PUBLIC)||!TYPES[extname(file)])throw new HttpError(404,'Not found');
   let content:Buffer;try{content=readFileSync(file);}catch{throw new HttpError(404,'Not found');}
   res.writeHead(200,{'content-type':TYPES[extname(file)]!,'cache-control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
  }catch(e){
   if(e instanceof HttpError)json(e.status,{error:e.message});
   else json(400,{error:(e as Error).message||'Invalid request'});
  }
 });
 return server;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const deployment=loadDeployment(process.env.BRIDGE_DEPLOYMENT_FILE??fileURLToPath(new URL('../docs/standard-testnet-deployment.json',import.meta.url)));
 const indexer=process.env.MIDNIGHT_INDEXER_URL;
 const midnight=indexer?await liveMidnight(deployment,indexer,process.env.MIDNIGHT_INDEXER_WS??indexer.replace(/^http/,'ws')+'/ws'):undefined;
 const port=Number(process.env.PORT??3080),host=process.env.HOST??'127.0.0.1';
 createApp({deployment,ton:liveTon(deployment),midnight,midnightUnavailable:'Midnight indexer not configured (the public preprod indexer was retired on 2026-10-09; set MIDNIGHT_INDEXER_URL)'}).listen(port,host,()=>console.log(`Bridge app: http://${host}:${port}`));
}
