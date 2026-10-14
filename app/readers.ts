import {readFileSync} from 'node:fs';
import {Address,Cell} from '@ton/core';
import {referenceWallet,validateAssets,type JettonAsset} from '../src/jettons.js';
import {observeTonDeposit,verifyEscrowPins,type DepositReceipt} from '../src/escrow.js';
import {TON_FINALITY_DEPTH,finalizedBlock,tonClient} from '../src/ton-network.js';

/** Public route description. Holds no keys; safe to serve to browsers. */
export type RouteAsset=JettonAsset&{escrow:string;codeHash:string;configHash:string};
export type Deployment={network:string;domain:string;midnight:string;assets:[RouteAsset,RouteAsset]};
export type TonStatus={block:number;assets:{asset:0|1;locked:string}[]};
export type Refund={id:string;amount:string};
export interface TonReader {
 status():Promise<TonStatus>;
 /** Jetton balance of a wallet, or null when the wallet is not deployed. */
 balance(wallet:Address):Promise<bigint|null>;
 receipt(route:RouteAsset,sequence:bigint):Promise<DepositReceipt>;
 /** Unpaid refund records whose recipient is `owner` (most recent first, bounded). */
 refunds(route:RouteAsset,owner:Address):Promise<Refund[]>;
}
export type MidnightSnapshot={reserve:[bigint,bigint];circulating:[bigint,bigint];totalShares:bigint;claimed:(id:string)=>boolean};
export interface MidnightReader {snapshot():Promise<MidnightSnapshot>}

const HASH=/^[a-f0-9]{64}$/;
export function loadDeployment(path:string):Deployment{
 const raw=JSON.parse(readFileSync(path,'utf8'));
 const assets=validateAssets(raw.ton.map(({escrow:_e,codeHash:_c,configHash:_h,...a}:RouteAsset)=>a));
 const routes=assets.map((a,i)=>{const r=raw.ton[i],escrow=Address.parse(r.escrow);
  if(escrow.workChain!==0||!HASH.test(r.codeHash)||!HASH.test(r.configHash))throw new Error('invalid escrow route');
  return {...a,escrow:escrow.toRawString(),codeHash:r.codeHash,configHash:r.configHash};}) as [RouteAsset,RouteAsset];
 if(!HASH.test(raw.domain)||!HASH.test(raw.midnight))throw new Error('invalid deployment identity');
 return {network:raw.network,domain:raw.domain,midnight:raw.midnight,assets:routes};
}
/** The owner's jetton wallet for a route, derived from the pinned wallet code. */
export const jettonWalletOf=(route:RouteAsset,owner:Address)=>referenceWallet(owner,Address.parse(route.master),Cell.fromBase64(route.walletCodeBoc)).address;

export function tonRpcReader(deployment:Deployment,endpoint?:string):TonReader{
 const client=tonClient(endpoint?{endpoint,timeout:15000}:{timeout:15000}),escrows=deployment.assets.map(r=>Address.parse(r.escrow));
 const int=async(block:number,a:Address,m:string)=>{const r=await client.runMethod(block,a,m);if(r.exitCode!==0)throw new Error(`${m} failed`);return r.reader.readBigNumber();};
 return {
  // Every status read re-checks the escrows' pinned code, configuration and cap, so a
  // retired or substituted route stops being offered for deposits.
  async status(){const {block}=await finalizedBlock(client);
   return {block,assets:await Promise.all(deployment.assets.map(async(r,i)=>{
    const {cap}=await verifyEscrowPins(client,block,{escrow:r.escrow,codeHash:r.codeHash,configHash:r.configHash});
    if(String(cap)!==r.cap)throw new Error('escrow cap differs from the route');
    return {asset:r.asset,locked:String(await int(block,escrows[i]!,'locked'))};}))};},
  async balance(wallet){const {block}=await finalizedBlock(client),a=await client.getAccount(block,wallet);
   if(a.account.state.type!=='active')return null;return int(block,wallet,'get_wallet_data');},
  async refunds(r,owner){const {block}=await finalizedBlock(client),escrow=Address.parse(r.escrow),count=await int(block,escrow,'refundCount'),out=[];
   for(let id=count-1n;id>=0n&&id>=count-200n;id--){const res=await client.runMethod(block,escrow,'refund',[{type:'int',value:id}]);if(res.exitCode!==0)continue;
    const s=res.reader.readCell().beginParse(),amount=s.loadCoins();if(s.loadAddress().equals(owner))out.push({id:String(id),amount:String(amount)});}
   return out;},
  receipt:(r,sequence)=>observeTonDeposit(client,{escrow:r.escrow,asset:r.asset,codeHash:r.codeHash,configHash:r.configHash,confirmationDepth:TON_FINALITY_DEPTH},sequence),
 };
}

/** Reads the bridge ledger from a Midnight indexer. Midnight deps load lazily so the
 * app starts (and tests run) without them when no indexer is configured. */
export async function midnightIndexerReader(deployment:Deployment,urls:{indexer:string;indexerWS:string}):Promise<MidnightReader>{
 const [{openIndexer},{ledger}]=await Promise.all([import('../src/midnight-indexer.js'),import('../build/midnight/contract/index.js')]);
 const provider=openIndexer('preprod',urls);
 return {async snapshot(){
  const state=await provider.queryContractState(deployment.midnight);if(!state)throw new Error('bridge contract not found on indexer');
  const l=ledger(state.data);
  return {reserve:[l.reserve[0]!,l.reserve[1]!],circulating:[l.circulating[0]!,l.circulating[1]!],totalShares:l.totalShares,claimed:id=>l.claimed.member(Buffer.from(id,'hex'))};
 }};
}
