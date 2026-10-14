import {dirname,join} from 'node:path';
import {Address,internal,toNano} from '@ton/core';
import {ledger} from '../build/midnight/contract/index.js';
import {acquireLock,network,readJson,statePath} from '../src/environment.js';
import {attestDeposit,attestRedemption,checkSlot,parseBridgeConfig,type DepositSignerConfig,type RedemptionSignerConfig} from '../src/attest.js';
import {Mailbox,parseRequest} from '../src/mailbox.js';
import {assertMidnightFinalized,MIDNIGHT_PREPROD_GENESIS,openIndexer} from '../src/midnight-indexer.js';
import {midnightEndpoints,redactEndpoints} from '../src/midnight-endpoints.js';
import {BridgeClient,type BridgeConfig} from '../src/sdk.js';
import {finalizedBlock,tonClient} from '../src/ton-network.js';
import {jsonLog,relayerPass,signerPass,type Log} from '../src/watcher.js';
import type {TonRelayConfig} from '../src/quorum.js';
import type {TestNetwork} from '../src/environment.js';
import type {TonClient4} from '@ton/ton';
import {flag} from './lib/util.js';

// Automated committee signer and relayer around a shared attestation mailbox. See
// docs/operations.md#automated-signing-and-relay.
const [command,path,requestPath]=process.argv.slice(2);
const usage='usage: npm run watch -- signer CONFIG [--once] | relayer CONFIG [--once] | request MAILBOX REQUEST_JSON';
if(!command||!path)throw new Error(usage);
const once=flag('--once');
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const withTimeout=<T>(p:Promise<T>,ms:number,what:string)=>{let t:ReturnType<typeof setTimeout>|undefined;
 return Promise.race([p,new Promise<never>((_,reject)=>{t=setTimeout(()=>reject(new Error(`${what} timed out`)),ms);})]).finally(()=>clearTimeout(t));};
/** Endpoint-redacting wrapper: errors may embed hosted-provider URLs with tokens. */
const redacted=(log:Log):Log=>(event,fields={})=>log(event,Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,typeof v==='string'?redactEndpoints(v):v])));
/** Number of the escrow's `releaseState` at the latest and the finalized block, whichever is set. */
async function releaseState(client:TonClient4,escrow:Address,id:string){
 const head=await client.getLastBlock(),{block}=await finalizedBlock(client);let state=0;
 for(const seqno of [head.last.seqno,block]){const r=await client.runMethod(seqno,escrow,'releaseState',[{type:'int',value:BigInt('0x'+id)}]);if(r.exitCode!==0)throw new Error('releaseState unavailable');state||=r.reader.readNumber();}
 return state;
}
/** Per-pass memo of the Midnight `claimed` set; one indexer read per pass. */
function claimedSet(net:TestNetwork,address:string,urls?:{indexer:string;indexerWS:string}){
 const provider=openIndexer(net,urls);let set:ReturnType<typeof ledger>['claimed']|undefined;
 return {reset:()=>{set=undefined;},has:async(id:string)=>{
  if(!set){const state=await provider.queryContractState(address);if(!state)throw new Error('Midnight contract not found');set=ledger(state.data).claimed;}
  return set.member(Buffer.from(id,'hex'));
 }};
}
async function run(pass:()=>Promise<number>,intervalMs:number){
 for(;;){const n=await pass();if(once){console.error(`Pass complete: ${n} item(s).`);return;}await sleep(intervalMs);}
}

if(command==='request'){
 if(!requestPath)throw new Error(usage);
 const queued=new Mailbox(path).submitRequest(parseRequest(readJson(requestPath)));
 console.log(queued?'Redemption request queued for the committee.':'This request was already queued.');
}else if(command==='signer'){
 const c=readJson<{mailbox:string;intervalMs?:number;deposits?:string[];redemption?:string;indexer?:string;indexerWS?:string}>(path);
 const deposits=(c.deposits??[]).map(p=>readJson<DepositSignerConfig>(p)),redemption=c.redemption?readJson<RedemptionSignerConfig>(c.redemption):undefined;
 const signers=new Set([...deposits.map(d=>d.signer),...redemption?[redemption.signer]:[]]);
 if(signers.size!==1)throw new Error('every signer config must use the same committee slot');
 const signer=[...signers][0]!;checkSlot(signer);
 const policy=deposits[0]?.policy??redemption!.policy;
 acquireLock(join(dirname(policy.database),'signer-watch.lock'),{signer},{exitOnSignal:true});
 const mailbox=new Mailbox(c.mailbox),log=redacted(jsonLog(`signer-${signer}`));
 const bridge=deposits[0]?parseBridgeConfig(deposits[0].bridge):undefined;
 const claimed=bridge?claimedSet(bridge.network,bridge.midnightAddress,c.indexer&&c.indexerWS?{indexer:c.indexer,indexerWS:c.indexerWS}:undefined):undefined;
 const sources=deposits.map(d=>{
  const ton=tonClient({endpoint:d.rpc});
  return {escrow:d.source.escrow,attest:(seq:bigint)=>attestDeposit(d,ton,seq),
   count:async()=>{const {block}=await finalizedBlock(ton,d.source.confirmationDepth),r=await ton.runMethod(block,Address.parse(d.source.escrow),'depositCount');if(r.exitCode!==0)throw new Error('depositCount unavailable');return r.reader.readBigNumber();}};
 });
 let redemptionDeps:Parameters<typeof signerPass>[0]['redemption'];
 if(redemption){
  const provider=openIndexer(redemption.network,redemption.indexer&&redemption.indexerWS?{indexer:redemption.indexer,indexerWS:redemption.indexerWS}:undefined),ton=tonClient(redemption.tonRpc?{endpoint:redemption.tonRpc}:undefined);
  const node=redemption.node??midnightEndpoints(redemption.network).node;
  const reads={ton,
   transaction:(id:string)=>withTimeout(provider.watchForTxData(id),30000,'Midnight transaction lookup'),
   assertFinalized:(h:number,hash:string)=>assertMidnightFinalized(node,h,hash,redemption.network==='preprod'?{genesis:MIDNIGHT_PREPROD_GENESIS}:{}),
   stateAt:(blockHash:string)=>provider.queryContractState(redemption.address,{type:'blockHash',blockHash})};
  redemptionDeps={attest:r=>attestRedemption(redemption,reads,r),
   released:async r=>{const pin=redemption.escrows[r.asset];return !!pin&&await releaseState(ton,Address.parse(pin.escrow),r.id)!==0;}};
 }
 await run(async()=>{
  claimed?.reset();
  return signerPass({mailbox,signer,deposits:sources,log,...redemptionDeps?{redemption:redemptionDeps}:{},
   // Signing an already-claimed deposit is harmless but spends quota; if Midnight is
   // unreadable, sign anyway rather than stall deposits.
   claimed:async id=>{if(!claimed)return false;try{return await claimed.has(id);}catch(error){log('claimed-check-failed',{error:String(error)});return false;}}});
 },c.intervalMs??30000);
}else if(command==='relayer'){
 const c=readJson<{mailbox:string;intervalMs?:number;bridge:BridgeConfig;ton?:TonRelayConfig}>(path);
 const config=parseBridgeConfig(c.bridge);
 if(network()!==config.network)throw new Error('BRIDGE_NETWORK must match the bridge config network');
 if(c.ton&&(c.ton.network!=='ton-testnet'||network()!=='preprod'))throw new Error('TON releases require ton.network "ton-testnet" and BRIDGE_NETWORK=preprod');
 acquireLock(statePath('relayer.lock'),{},{exitOnSignal:true});
 const mailbox=new Mailbox(c.mailbox),log=redacted(jsonLog('relayer')),claimed=claimedSet(config.network,config.midnightAddress),ton=tonClient(),done=new Set<string>();
 const bridge=new BridgeClient(config,{call:async(circuit,args)=>{
  // The wallet opens on first use and stays open; its journal refuses new calls while any
  // earlier Midnight transaction is unreconciled.
  midnight??=await (await import('../src/live-midnight.js')).openMidnight();
  return (await midnight.call(config.midnightAddress,circuit,args)).public.txId;
 }});
 let midnight:Awaited<ReturnType<typeof import('../src/live-midnight.js')['openMidnight']>>|undefined;
 const close=async()=>{await midnight?.close();};
 try{
  await run(async()=>{
   claimed.reset();
   return relayerPass({mailbox,bridge,log,done,...c.ton?{ton:c.ton}:{},
    claimed:id=>claimed.has(id),
    submitClaim:(receipt,attestations)=>bridge.claim(receipt,attestations),
    releaseState:(escrow,id)=>releaseState(ton,escrow,id),
    sendRelease:async(escrow,body,journalId)=>{
     const {openTon}=await import('../src/live-ton.js');
     return openTon(c.ton!.walletKeyFile).send(journalId,[internal({to:escrow,value:toNano('0.2'),body})],{afterConfirmed:true});
    }});
  },c.intervalMs??30000);
 }finally{await close();}
}else throw new Error(usage);
