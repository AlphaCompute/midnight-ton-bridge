import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {Address,Cell,toNano} from '@ton/core';
import {UnshieldedAddress} from '@midnight-ntwrk/wallet-sdk-address-format';
import {createApp,loadDeployment,toUnits,midnightRecipient,DEPOSIT_ATTACHED_TON,type TonReader,type MidnightReader} from '../app/server.js';
import {referenceWallet} from '../src/jettons.js';
import {quoteSwap} from '../src/midnight.js';
import {depositId} from '../src/receipts.js';

const deployment=loadDeployment('docs/standard-testnet-deployment.json');
const owner=Address.parse('0:'+'11'.repeat(32));
const recipientHex='07'.repeat(32);
const recipientBech=UnshieldedAddress.codec.encode('preprod',new UnshieldedAddress(Buffer.from(recipientHex,'hex'))).asString();
const userWallet=(asset:0|1)=>referenceWallet(owner,Address.parse(deployment.assets[asset].master),Cell.fromBase64(deployment.assets[asset].walletCodeBoc)).address;

function fakes(over:{balance?:bigint|null|Error;locked?:bigint;tonDown?:boolean;claimed?:string[]}={}){
 const ton:TonReader={
  async status(){if(over.tonDown)throw new Error('rpc down');return {block:100,assets:[{asset:0,locked:String(over.locked??9900n),deposits:'1'},{asset:1,locked:'10000',deposits:'1'}]};},
  async balance(w){if(over.balance instanceof Error)throw over.balance;assert.ok(w.equals(userWallet(0))||w.equals(userWallet(1)));return over.balance===undefined?5_000_000n:over.balance;},
  async receipt(r,seq){if(seq>0n)throw new Error('deposit not found');
   return {id:depositId(r.escrow,seq),network:'ton-testnet',escrow:r.escrow,sequence:String(seq),asset:r.asset,amount:'9900',recipient:recipientHex,block:97,blockRoot:'root'};},
 };
 const midnight:MidnightReader={async snapshot(){return {reserve:[5000n,5000n],circulating:[9900n,10000n],totalShares:5000n,claimed:id=>(over.claimed??[]).includes(id)};}};
 return {ton,midnight};
}
async function serve(app:ReturnType<typeof createApp>){
 app.listen(0,'127.0.0.1');await once(app,'listening');const base=`http://127.0.0.1:${(app.address() as AddressInfo).port}`;
 const get=(p:string)=>fetch(base+p),post=(p:string,b:unknown,h:Record<string,string>={})=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b)});
 return {base,get,post,close:async()=>{app.closeAllConnections();await new Promise(r=>app.close(r));}};
}
const deposit={asset:0,amount:'1.5',tonAddress:owner.toString({testOnly:true}),midnightRecipient:recipientBech};

test('amount and recipient parsing',()=>{
 assert.equal(toUnits('1.5',6),1_500_000n);assert.equal(toUnits('0.000001',6),1n);assert.equal(toUnits('42',0),42n);
 assert.throws(()=>toUnits('0.0000001',6),/decimal places/);assert.throws(()=>toUnits('0',6),/positive/);assert.throws(()=>toUnits('-1',6));assert.throws(()=>toUnits('1e3',6));
 assert.throws(()=>toUnits('18446744073709.551616',6),/uint64/);
 assert.equal(midnightRecipient(recipientBech).toString('hex'),recipientHex);assert.equal(midnightRecipient(recipientHex.toUpperCase()).toString('hex'),recipientHex);
 assert.throws(()=>midnightRecipient(UnshieldedAddress.codec.encode('undeployed',new UnshieldedAddress(Buffer.alloc(32,1))).asString()),/preprod/);
 assert.throws(()=>midnightRecipient('mn_addr_preprod1nope'),/mn_addr_preprod/);
});

test('serves the UI and public route configuration only',async()=>{
 const s=await serve(createApp({deployment,...fakes()}));
 try{
  const home=await s.get('/');assert.equal(home.status,200);assert.match(await home.text(),/Midnight–TON Bridge/);
  assert.match(home.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
  for(const f of ['/app.js','/app.css','/icon.svg'])assert.equal((await s.get(f)).status,200,f);
  assert.equal((await s.get('/../server.ts')).status,404);assert.equal((await s.get('/%2e%2e/server.ts')).status,404);
  const c=await (await s.get('/api/config')).json();
  assert.equal(c.midnight,deployment.midnight);assert.deepEqual(c.assets.map((a:{symbol:string})=>a.symbol),['BRIDGE-0','BRIDGE-1']);
  assert.equal(Address.parse(c.assets[0].escrow).toRawString(),deployment.assets[0].escrow);
  assert.ok(!JSON.stringify(c).includes('walletCodeBoc'));
  const st=await (await s.get('/api/status')).json();assert.equal(st.ton.locked,undefined);assert.equal(st.ton.assets[0].locked,'9900');assert.deepEqual(st.midnight.reserve,['5000','5000']);
  const bal=await (await s.get('/api/balances?owner='+encodeURIComponent(deposit.tonAddress))).json();
  assert.ok(Address.parse(bal.assets[1].wallet).equals(userWallet(1)));assert.equal(bal.assets[0].balance,'5000000');
 }finally{await s.close();}
});

test('prepares an unsigned deposit to the sender jetton wallet, never the escrow',async()=>{
 const s=await serve(createApp({deployment,...fakes()}));
 try{
  const r=await s.post('/api/deposit',deposit);assert.equal(r.status,200);const d=await r.json();
  assert.equal(d.units,'1500000');assert.deepEqual(d.warnings,[]);
  const to=Address.parse(d.tonConnect.messages[0].address);assert.ok(to.equals(userWallet(0)));assert.ok(!to.equals(Address.parse(deployment.assets[0].escrow)));
  assert.equal(d.tonConnect.messages[0].amount,DEPOSIT_ATTACHED_TON.toString());assert.equal(d.tonConnect.network,'-3');
  assert.ok(d.deepLink.startsWith(`ton://transfer/${d.jettonWallet}?amount=${DEPOSIT_ATTACHED_TON}&bin=`));
  const b=Cell.fromBase64(d.tonConnect.messages[0].payload).beginParse();
  assert.equal(b.loadUint(32),0x0f8a7ea5);assert.equal(b.loadUintBig(64),BigInt(d.queryId));assert.equal(b.loadCoins(),1_500_000n);
  assert.ok(b.loadAddress().equals(Address.parse(deployment.assets[0].escrow)));assert.ok(b.loadAddress().equals(owner));
  assert.equal(b.loadBit(),false);assert.equal(b.loadCoins(),toNano('0.01'));assert.equal(b.loadBit(),false);
  assert.equal(b.loadBuffer(32).toString('hex'),recipientHex);assert.equal(b.remainingBits,0);
  const deep=Cell.fromBoc(Buffer.from(decodeURIComponent(d.deepLink.split('bin=')[1]),'base64url'))[0]!;assert.equal(deep.toBoc().toString('base64'),d.payload);
 }finally{await s.close();}
});

test('deposit guards: balance, cap, input and degraded RPC',async()=>{
 const cases:[Parameters<typeof fakes>[0],Record<string,unknown>,number,RegExp][]=[
  [{balance:1n},{},400,/Insufficient BRIDGE-0/],
  [{balance:null},{},400,/wallet holds 0/],
  [{locked:999_999_000_000n},{},400,/route cap \(1 BRIDGE-0 remaining\)/],
  [{},{asset:2},400,/Unknown asset/],
  [{},{tonAddress:'-1:'+'11'.repeat(32)},400,/basechain/],
  [{},{tonAddress:'nope'},400,/valid TON address/],
  [{},{midnightRecipient:''},400,/Midnight recipient/],
  [{},{amount:'1.0000001'},400,/decimal places/],
 ];
 for(const [over,patch,status,msg] of cases){
  const s=await serve(createApp({deployment,...fakes(over)}));
  try{const r=await s.post('/api/deposit',{...deposit,...patch});assert.equal(r.status,status,JSON.stringify(patch));assert.match((await r.json()).error,msg);}finally{await s.close();}
 }
 const s=await serve(createApp({deployment,...fakes({tonDown:true,balance:new Error('rpc')})}));
 try{const d=await (await s.post('/api/deposit',deposit)).json();assert.equal(d.warnings.length,2);assert.ok(d.payload);}finally{await s.close();}
});

test('tracks receipts and claim status',async()=>{
 const id=depositId(deployment.assets[0].escrow,0n);
 for(const [claimed,expected] of [[[id],true],[[],false]] as const){
  const s=await serve(createApp({deployment,...fakes({claimed:[...claimed]})}));
  try{const r=await (await s.get('/api/deposit?asset=0&sequence=0')).json();assert.equal(r.id,id);assert.equal(r.claimed,expected);assert.equal(r.display,'0.0099');}finally{await s.close();}
 }
 const {ton}=fakes(),s=await serve(createApp({deployment,ton,midnightUnavailable:'indexer retired'}));
 try{
  const r=await (await s.get('/api/deposit?asset=1&sequence=0')).json();assert.equal(r.claimed,null);assert.equal(r.midnightNote,'indexer retired');
  assert.equal((await s.get('/api/deposit?asset=0&sequence=5')).status,404);assert.equal((await s.get('/api/deposit?asset=0&sequence=-1')).status,400);
  const st=await (await s.get('/api/status')).json();assert.equal(st.midnight.available,false);assert.equal(st.midnight.error,'indexer retired');
  assert.equal((await s.post('/api/quote',{assetIn:0,amount:'1'})).status,503);
 }finally{await s.close();}
});

test('quotes swaps with the contract formula and slippage floor',async()=>{
 const s=await serve(createApp({deployment,...fakes()}));
 try{
  const q=await (await s.post('/api/quote',{assetIn:0,amount:'0.0001',slippageBps:100})).json();
  const out=quoteSwap(100n,5000n,5000n);assert.equal(q.outUnits,String(out));assert.equal(q.minOutUnits,String(out*9900n/10000n));
  assert.ok(q.priceImpact>0&&q.priceImpact<0.05);assert.equal(q.symbolOut,'BRIDGE-1');
  assert.equal((await s.post('/api/quote',{assetIn:0,amount:'0.000001',slippageBps:50})).status,400);
  assert.equal((await s.post('/api/quote',{assetIn:0,amount:'1',slippageBps:9000})).status,400);
 }finally{await s.close();}
});

test('rejects cross-origin, non-JSON and oversized posts',async()=>{
 const s=await serve(createApp({deployment,...fakes()}));
 try{
  assert.equal((await s.post('/api/deposit',deposit,{origin:'https://evil.example'})).status,403);
  assert.equal((await fetch(s.base+'/api/deposit',{method:'POST',body:'x'})).status,415);
  assert.equal((await s.post('/api/deposit',{pad:'x'.repeat(9000)})).status,413);
  assert.equal((await s.post('/api/deposit',[1])).status,400);
  assert.equal((await s.get('/api/nope')).status,404);
 }finally{await s.close();}
});
