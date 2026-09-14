import {resolve} from 'node:path';
import pino from 'pino';
import WebSocket from 'ws';
import {MidnightWalletProvider,inMemoryPrivateStateProvider,type EnvironmentConfiguration} from '@midnight-ntwrk/testkit-js';
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id';
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {httpClientProofProvider} from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import {deployContract,submitCallTx} from '@midnight-ntwrk/midnight-js-contracts';
import {Contract} from '../build/midnight/contract/index.js';
import {witnesses} from './midnight.js';
import {Journal} from './journal.js';
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {sampleSigningKey} from '@midnight-ntwrk/ledger-v8';

export async function openMidnight(){
 const network=process.env.MIDNIGHT_NETWORK??'local';
 if(network!=='local'&&network!=='preprod')throw new Error('test networks only');
 const local=network==='local',networkId=local?'undeployed':'preprod';
 const env:EnvironmentConfiguration={walletNetworkId:networkId,networkId,
  node:process.env.MIDNIGHT_NODE_URL??(local?'http://127.0.0.1:19944':'https://rpc.preprod.midnight.network'),
  nodeWS:process.env.MIDNIGHT_NODE_WS??(local?'ws://127.0.0.1:19944':'wss://rpc.preprod.midnight.network'),
  indexer:process.env.MIDNIGHT_INDEXER_URL??(local?'http://127.0.0.1:18088/api/v3/graphql':'https://indexer.preprod.midnight.network/api/v3/graphql'),
  indexerWS:process.env.MIDNIGHT_INDEXER_WS??(local?'ws://127.0.0.1:18088/api/v3/graphql/ws':'wss://indexer.preprod.midnight.network/api/v3/graphql/ws'),
  proofServer:process.env.MIDNIGHT_PROOF_SERVER??'http://127.0.0.1:16300',faucet:undefined};
 const seed=process.env.MIDNIGHT_SEED??(local?'0'.repeat(63)+'1':undefined);
 if(!seed||!/^[a-f0-9]{64}$/i.test(seed))throw new Error('MIDNIGHT_SEED must be 32-byte hex');
 setNetworkId(networkId);
 // SDK wallet builder logs its seed to the supplied logger. Suppress it entirely.
 globalThis.WebSocket=WebSocket as unknown as typeof globalThis.WebSocket;
 const wallet=await MidnightWalletProvider.build(pino({level:'silent'}),env,seed);
 mkdirSync('.state',{recursive:true,mode:0o700});
 const journal=new Journal('.state/midnight-transactions.sqlite');
 const path=resolve('build/midnight');
 const zkConfigProvider=new NodeZkConfigProvider<'claim'|'redeem'|'addLiquidity'|'swap'|'removeLiquidity'>(path);
 const providers={privateStateProvider:inMemoryPrivateStateProvider<string,Record<string,never>>(),
  publicDataProvider:indexerPublicDataProvider(env.indexer,env.indexerWS),zkConfigProvider,
  proofProvider:httpClientProofProvider(env.proofServer,zkConfigProvider),walletProvider:wallet,
  midnightProvider:{submitTx:async(tx:Parameters<typeof wallet.submitTx>[0])=>{
   const id=tx.identifiers()[0];if(!id)throw new Error('transaction has no identifier');
   const raw=Buffer.from(tx.serialize()).toString('hex');
   const previous=journal.get(id);
   if(previous)throw new Error(`transaction ${id} already journaled; reconcile before retrying`);
   journal.observe(id,'midnight signed transaction');journal.move(id,'observed','prepared',raw,id);journal.move(id,'prepared','sending');
   const result=await wallet.submitTx(tx);journal.move(id,'sending','submitted');return result;
  }}};
 const compiled=CompiledContract.make('AlphaTONBridge',Contract).pipe(CompiledContract.withWitnesses(witnesses),CompiledContract.withCompiledFileAssets(path));
 try{await wallet.start(true);}catch(error){await wallet.stop().catch(()=>{});journal.close();throw error;}
 const finalize=(data:{status:string;identifiers:readonly string[]})=>{
  for(const id of data.identifiers){const row=journal.get(id);if(row&&(row.stage==='sending'||row.stage==='submitted'))journal.move(id,row.stage,data.status==='SucceedEntirely'?'confirmed':'rejected',null,null,data.status==='SucceedEntirely'?null:data.status);}
  if(data.status!=='SucceedEntirely')throw new Error(`Midnight transaction failed: ${data.status}`);
 };
 return {wallet,providers,compiled,env,journal,
  deploy:async(domain:Uint8Array,keys:Parameters<Contract['initialState']>[2],cap:bigint)=>{
   const keyFile='.state/midnight-maintenance-key.json';
   if(!existsSync(keyFile))writeFileSync(keyFile,JSON.stringify({signingKey:sampleSigningKey()}),{mode:0o600,flag:'wx'});
   const {signingKey}=JSON.parse(readFileSync(keyFile,'utf8')) as {signingKey:string};
   const result=await deployContract(providers,{compiledContract:compiled,privateStateId:'bridge',initialPrivateState:{},signingKey,args:[domain,keys,cap]});finalize(result.deployTxData.public);return result;
  },
  reconcile:async(id:string)=>{const data=await providers.publicDataProvider.watchForTxData(id);finalize(data);return {status:data.status,txId:data.txId,blockHeight:data.blockHeight};},
  call:async(address:string,circuit:'claim'|'redeem'|'addLiquidity'|'swap'|'removeLiquidity',args:unknown[])=>{
   // This contract has no persistent private application state. Restore its empty
   // witness state when opening an existing deployment in a fresh process.
   await providers.privateStateProvider.setContractAddress(address);
   if(await providers.privateStateProvider.get('bridge')===null)await providers.privateStateProvider.set('bridge',{});
   // The SDK validates user arguments and generated bindings validate circuit shapes.
   const result=await submitCallTx(providers,{compiledContract:compiled,contractAddress:address,privateStateId:'bridge',circuitId:circuit,args:args as never});finalize(result.public);return result;
  },
  close:async()=>{await wallet.stop();journal.close();}
 };
}
