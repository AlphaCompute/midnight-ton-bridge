import WebSocket from 'ws';
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id';
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type {TestNetwork} from './environment.js';
import {midnightIndexer,redactProcessOutput} from './midnight-endpoints.js';

export {midnightNetworkId} from './midnight-network.js';
import {midnightNetworkId} from './midnight-network.js';
/** Midnight wallet and indexer clients expect the `ws` WebSocket implementation globally. */
export function installWebSocket(){globalThis.WebSocket=WebSocket as unknown as typeof globalThis.WebSocket;}
/** Read-only public-data provider: no wallet, seed or journal. Explicit URLs may carry a
 * hosted-provider token, so process output is redacted whenever they are supplied. */
export function openIndexer(network:TestNetwork,urls?:{indexer:string;indexerWS:string}){
 if(urls)redactProcessOutput();
 const {indexer,indexerWS}=urls??midnightIndexer(network);
 setNetworkId(midnightNetworkId(network));installWebSocket();
 return indexerPublicDataProvider(indexer,indexerWS);
}
/** Throws unless the node reports `blockHash` as the canonical block at `blockHeight` and
 * that height as finalized. Indexer data alone is not finality: a release signed against a
 * block later reorganized away would pay TON while the Midnight tokens stay unburned. */
/** Midnight preprod genesis block hash (`chain_getBlockHash(0)`), recorded 2026-10-13. */
export const MIDNIGHT_PREPROD_GENESIS='df831b09a8baa92badf47762ce5ac439b7e47e3ed3d39600cfdd44fad552361b';
export async function assertMidnightFinalized(nodeUrl:string,blockHeight:number,blockHash:string,{genesis}:{genesis?:string}={}){
 const rpc=async(method:string,params:unknown[])=>{
  const res=await fetch(nodeUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
  const body=await res.json() as {result?:unknown;error?:{message:string}};if(!res.ok||body.error||body.result===undefined)throw new Error(`Midnight node ${method} failed`);return body.result;
 };
 const hex=(v:unknown)=>String(v).replace(/^0x/,'').toLowerCase();
 // Like TON's zero-state pin: a node for another chain fails before anything is trusted.
 if(genesis!==undefined&&hex(await rpc('chain_getBlockHash',[0]))!==genesis)throw new Error('Midnight node is not on the pinned network');
 const finalized=await rpc('chain_getFinalizedHead',[]) as string,header=await rpc('chain_getHeader',[finalized]) as {number:string};
 if(Number.parseInt(header.number,16)<blockHeight)throw new Error(`Midnight block ${blockHeight} is not finalized yet; retry later`);
 if(hex(await rpc('chain_getBlockHash',[blockHeight]))!==hex(blockHash))throw new Error(`Indexer block ${blockHeight} is not the node's canonical block`);
}
