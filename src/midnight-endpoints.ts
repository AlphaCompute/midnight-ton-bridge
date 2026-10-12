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
  redactProcessOutput();return withToken(fallback,token);};
 return {node:need(env.MIDNIGHT_NODE_URL,'https://rpc.midnight-preprod.blockfrost.io'),nodeWS:need(env.MIDNIGHT_NODE_WS,'wss://rpc.midnight-preprod.blockfrost.io'),
  indexer:need(env.MIDNIGHT_INDEXER_URL,'https://midnight-preprod.blockfrost.io/api/v0'),indexerWS:need(env.MIDNIGHT_INDEXER_WS,'wss://midnight-preprod.blockfrost.io/api/v0/ws'),proofServer};
}
/** Indexer endpoints for read-only tools. An explicit MIDNIGHT_INDEXER_URL wins; its
 * WebSocket defaults to the same URL with a ws scheme and `/ws` path, keeping any query. */
export function midnightIndexer(network:Network,env:NodeJS.ProcessEnv=process.env):{indexer:string;indexerWS:string}{
 const indexer=env.MIDNIGHT_INDEXER_URL;
 if(indexer){
  if(indexer.includes('project_id='))redactProcessOutput();
  const ws=new URL(indexer);ws.protocol=ws.protocol==='https:'?'wss:':'ws:';ws.pathname=ws.pathname.replace(/\/?$/,'/ws');
  return {indexer,indexerWS:env.MIDNIGHT_INDEXER_WS??ws.toString()};
 }
 const e=midnightEndpoints(network,{...env,MIDNIGHT_NODE_URL:'unused',MIDNIGHT_NODE_WS:'unused'});
 return {indexer:e.indexer,indexerWS:e.indexerWS};
}
/** Removes Blockfrost tokens from text before it is logged. */
export const redactEndpoints=(text:string)=>text.replace(/project_id=[^&\s"']+/g,'project_id=REDACTED');
let redacting=false;
/** Redacts Blockfrost tokens from everything this process writes to stdout and stderr.
 * Dependencies log full endpoint URLs (the Polkadot provider does on every disconnect),
 * so redacting only our own messages would still leak the token. Idempotent. */
export function redactProcessOutput(){
 if(redacting)return;redacting=true;
 for(const stream of [process.stdout,process.stderr]){
  const write=stream.write.bind(stream) as (chunk:unknown,...rest:unknown[])=>boolean;
  // Bytes pass through unchanged unless they hold a token; latin1 round-trips any byte.
  const bytes=(c:Uint8Array)=>{const b=Buffer.from(c.buffer,c.byteOffset,c.byteLength);return b.includes('project_id=')?Buffer.from(redactEndpoints(b.toString('latin1')),'latin1'):c;};
  stream.write=((chunk:unknown,...rest:unknown[])=>write(typeof chunk==='string'?redactEndpoints(chunk):chunk instanceof Uint8Array?bytes(chunk):chunk,...rest)) as typeof stream.write;
 }
}
