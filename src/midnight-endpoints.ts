import type {Network} from './environment.js';
export type MidnightEndpoints={node:string;nodeWS:string;indexer:string;indexerWS:string;proofServer:string};
const withToken=(url:string,token:string)=>`${url}${url.includes('?')?'&':'?'}project_id=${encodeURIComponent(token)}`;
/** Midnight endpoints for a network. Midnight retired its hosted preprod indexer and
 * RPC on 2026-10-09; preprod is served by Blockfrost and needs BLOCKFROST_PROJECT_ID
 * unless every MIDNIGHT_* endpoint is overridden (for example a self-hosted node). */
export function midnightEndpoints(network:Network,env:NodeJS.ProcessEnv=process.env):MidnightEndpoints{
 const proofServer=env.MIDNIGHT_PROOF_SERVER??'http://127.0.0.1:16300';
 if(network==='local')return {node:env.MIDNIGHT_NODE_URL??'http://127.0.0.1:19944',nodeWS:env.MIDNIGHT_NODE_WS??'ws://127.0.0.1:19944',
  indexer:env.MIDNIGHT_INDEXER_URL??'http://127.0.0.1:18088/api/v3/graphql',indexerWS:env.MIDNIGHT_INDEXER_WS??'ws://127.0.0.1:18088/api/v3/graphql/ws',proofServer};
 if(network!=='preprod')throw new Error('test networks only');
 const token=env.BLOCKFROST_PROJECT_ID?.trim(),need=(url:string|undefined,fallback:string)=>{
  if(url)return url;if(!token)throw new Error('Set BLOCKFROST_PROJECT_ID to a Midnight Preprod project ID (or set every MIDNIGHT_* endpoint)');
  if(!token.startsWith('nightpreprod'))throw new Error('BLOCKFROST_PROJECT_ID is not a Midnight Preprod project ID');
  return withToken(fallback,token);};
 return {node:need(env.MIDNIGHT_NODE_URL,'https://rpc.midnight-preprod.blockfrost.io'),nodeWS:need(env.MIDNIGHT_NODE_WS,'wss://rpc.midnight-preprod.blockfrost.io'),
  indexer:need(env.MIDNIGHT_INDEXER_URL,'https://midnight-preprod.blockfrost.io/api/v0'),indexerWS:need(env.MIDNIGHT_INDEXER_WS,'wss://midnight-preprod.blockfrost.io/api/v0/ws'),proofServer};
}
/** Removes Blockfrost tokens from text before it is logged. */
export const redactEndpoints=(text:string)=>text.replace(/project_id=[^&\s"']+/g,'project_id=REDACTED');
