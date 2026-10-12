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
