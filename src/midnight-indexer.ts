import WebSocket from 'ws';
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id';
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type {TestNetwork} from './environment.js';
import {midnightIndexer,redactProcessOutput} from './midnight-endpoints.js';

export const midnightNetworkId=(network:TestNetwork)=>network==='local'?'undeployed':'preprod';
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
export async function assertMidnightFinalized(nodeUrl:string,blockHeight:number,blockHash:string){
 const rpc=async(method:string,params:unknown[])=>{
  const res=await fetch(nodeUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
  const body=await res.json() as {result?:unknown;error?:{message:string}};if(!res.ok||body.error||body.result===undefined)throw new Error(`Midnight node ${method} failed`);return body.result;
 };
 const finalized=await rpc('chain_getFinalizedHead',[]) as string,header=await rpc('chain_getHeader',[finalized]) as {number:string};
 if(Number.parseInt(header.number,16)<blockHeight)throw new Error(`Midnight block ${blockHeight} is not finalized yet; retry later`);
 const canonical=String(await rpc('chain_getBlockHash',[blockHeight])).replace(/^0x/,'').toLowerCase();
 if(canonical!==blockHash.replace(/^0x/,'').toLowerCase())throw new Error(`Indexer block ${blockHeight} is not the node's canonical block`);
}
