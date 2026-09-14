import {ApiPromise,WsProvider} from '@polkadot/api';
import {buildPersistentWallet} from './wallet-builder.js';
import {firstValueFrom,filter,timeout} from 'rxjs';
import {network as configuredNetwork,readSecret,statePath,stateDirectory} from './environment.js';
import {resolve} from 'node:path';
import pino from 'pino';
import WebSocket from 'ws';
import {MidnightWalletProvider,inMemoryPrivateStateProvider,type EnvironmentConfiguration} from '@midnight-ntwrk/testkit-js';
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id';
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {httpClientProofProvider} from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import {createUnprovenDeployTx,submitTx,submitCallTx} from '@midnight-ntwrk/midnight-js-contracts';
import {Contract} from '../build/midnight/contract/index.js';
import {witnesses} from './midnight.js';
import {Journal} from './journal.js';
import {mkdirSync,writeFileSync,existsSync,readFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {sampleSigningKey,ContractState,ContractDeploy,ContractMaintenanceAuthority,Transaction,Intent,unshieldedToken} from '@midnight-ntwrk/ledger-v8';

export async function openMidnight(options:{waitForFunds?:boolean}={}){
 const network=configuredNetwork();
 if(network!=='local'&&network!=='preprod')throw new Error('test networks only');
 const local=network==='local',networkId=local?'undeployed':'preprod';
 const env:EnvironmentConfiguration={walletNetworkId:networkId,networkId,
  node:process.env.MIDNIGHT_NODE_URL??(local?'http://127.0.0.1:19944':'https://rpc.preprod.midnight.network'),
  nodeWS:process.env.MIDNIGHT_NODE_WS??(local?'ws://127.0.0.1:19944':'wss://rpc.preprod.midnight.network'),
  indexer:process.env.MIDNIGHT_INDEXER_URL??(local?'http://127.0.0.1:18088/api/v3/graphql':'https://indexer.preprod.midnight.network/api/v3/graphql'),
  indexerWS:process.env.MIDNIGHT_INDEXER_WS??(local?'ws://127.0.0.1:18088/api/v3/graphql/ws':'wss://indexer.preprod.midnight.network/api/v3/graphql/ws'),
  proofServer:process.env.MIDNIGHT_PROOF_SERVER??'http://127.0.0.1:16300',faucet:undefined};
 const seed=process.env.MIDNIGHT_SEED??(local?'0'.repeat(63)+'1':readSecret<{seed:string}>(process.env.MIDNIGHT_SEED_FILE??statePath('midnight-test-wallet.json')).seed);
 if(!seed||!/^[a-f0-9]{64}$/i.test(seed))throw new Error('MIDNIGHT_SEED must be 32-byte hex');
 setNetworkId(networkId);
 // SDK wallet builder logs its seed to the supplied logger. Suppress it entirely.
 globalThis.WebSocket=WebSocket as unknown as typeof globalThis.WebSocket;
 const lockPath=statePath('midnight-wallet.lock'),lockFd=openSync(lockPath,'wx',0o600);
 writeFileSync(lockFd,JSON.stringify({pid:process.pid,network:networkId}));
 const unlock=()=>{closeSync(lockFd);unlinkSync(lockPath);};
 let built:Awaited<ReturnType<typeof buildPersistentWallet>>;
 try{built=await buildPersistentWallet(env,seed);}catch(error){unlock();throw error;}
 const wallet=built.provider;
 const checkpoint=setInterval(()=>{void built.save().catch(e=>console.error('Wallet checkpoint failed:',String(e)));},60000);
 checkpoint.unref();
 stateDirectory();
 const journal=new Journal(statePath('midnight-transactions.sqlite'));
 const path=resolve('build/midnight');
 const zkConfigProvider=new NodeZkConfigProvider<'claim'|'redeem'|'addLiquidity'|'swap'|'removeLiquidity'>(path);
 let nodeApi:ApiPromise|undefined;
 const providers={privateStateProvider:inMemoryPrivateStateProvider<string,Record<string,never>>(),
  publicDataProvider:indexerPublicDataProvider(env.indexer,env.indexerWS),zkConfigProvider,
  proofProvider:httpClientProofProvider(env.proofServer,zkConfigProvider),walletProvider:wallet,
  midnightProvider:{submitTx:async(tx:Parameters<typeof wallet.submitTx>[0],purpose='midnight signed transaction')=>{
   const id=tx.identifiers()[0];if(!id)throw new Error('transaction has no identifier');
   const raw=Buffer.from(tx.serialize()).toString('hex');
   const previous=journal.get(id);
   if(previous)throw new Error(`transaction ${id} already journaled; reconcile before retrying`);
   journal.observe(id,purpose);journal.move(id,'observed','prepared',raw,id);
   await wallet.wallet.pendingTransactionsService.addPendingTransaction(tx);
   // @ts-expect-error Polkadot WsProvider's optional ttl differs under exactOptionalPropertyTypes.
   nodeApi??=await ApiPromise.create({provider:new WsProvider(env.nodeWS),noInitWarn:true});
   const send=nodeApi.tx.midnight?.sendMnTransaction;if(!send)throw new Error('node lacks Midnight transaction extrinsic');
   journal.move(id,'prepared','sending');
   await nodeApi.rpc.author.submitExtrinsic(send('0x'+raw).toHex());
   journal.move(id,'sending','submitted');return id;
  }}};
 const compiled=CompiledContract.make('AlphaTONBridge',Contract).pipe(CompiledContract.withWitnesses(witnesses),CompiledContract.withCompiledFileAssets(path));
 try{
  await wallet.start(false);
  if(options.waitForFunds??true){
   const synced=()=>firstValueFrom(wallet.wallet.state().pipe(filter(s=>s.shielded.state.progress.isStrictlyComplete()&&s.dust.state.progress.isStrictlyComplete()&&s.unshielded.progress.isStrictlyComplete()),timeout(3600000)));
   let state=await synced();
   if(!Object.values(state.unshielded.balances).some(n=>n>0n))throw new Error('Wallet has no test funds; fund its address before deployment');
   if(state.dust.balance(new Date())===0n){
    if(journal.list().some(r=>r.stage==='prepared'||r.stage==='sending'||r.stage==='submitted'))throw new Error('Reconcile pending transactions before DUST registration');
    const coins=state.unshielded.availableCoins.filter(c=>c.utxo.type===unshieldedToken().raw&&!c.meta.registeredForDustGeneration);
    if(coins.length){
     const recipe=await wallet.wallet.registerNightUtxosForDustGeneration(coins,wallet.unshieldedKeystore.getPublicKey(),p=>wallet.unshieldedKeystore.signData(p));
     const tx=await wallet.wallet.finalizeRecipe(recipe),id=await providers.midnightProvider.submitTx(tx,'DUST registration');
     const result=await providers.publicDataProvider.watchForTxData(id);journal.move(id,'submitted',result.status==='SucceedEntirely'?'confirmed':'rejected');
     if(result.status!=='SucceedEntirely')throw new Error('DUST registration failed');
    }
    await firstValueFrom(wallet.wallet.state().pipe(filter(s=>s.dust.state.progress.isStrictlyComplete()&&s.dust.balance(new Date())>0n),timeout(300000)));
   }
  }
 }catch(error){clearInterval(checkpoint);await built.save().catch(()=>{});await wallet.stop().catch(()=>{});journal.close();await nodeApi?.disconnect();unlock();throw error;}
 const finalize=(data:{status:string;identifiers:readonly string[]})=>{
  for(const id of data.identifiers){const row=journal.get(id);if(row&&(row.stage==='sending'||row.stage==='submitted'))journal.move(id,row.stage,data.status==='SucceedEntirely'?'confirmed':'rejected',null,null,data.status==='SucceedEntirely'?null:data.status);}
  if(data.status!=='SucceedEntirely')throw new Error(`Midnight transaction failed: ${data.status}`);
 };
 return {wallet,providers,compiled,env,journal,
  deploy:async(domain:Uint8Array,keys:Parameters<Contract['initialState']>[2],cap:bigint)=>{
   if(journal.list().some(r=>r.stage==='prepared'||r.stage==='sending'||r.stage==='submitted'))throw new Error('Reconcile pending Midnight transactions before deploying');
   // Build the constructor with the official SDK, then deploy its public state
   // with an impossible maintenance threshold. No upgrade key exists on chain.
   const prepared=await createUnprovenDeployTx(providers,{compiledContract:compiled,initialPrivateState:{},signingKey:sampleSigningKey(),args:[domain,keys,cap]});
   const initial=ContractState.deserialize(prepared.public.initialContractState.serialize());
   initial.maintenanceAuthority=new ContractMaintenanceAuthority([],1);
   const deployment=new ContractDeploy(initial);
   writeFileSync(statePath('midnight-deployment-candidate.json'),JSON.stringify({address:deployment.address,domain:Buffer.from(domain).toString('hex'),network:networkId}),{mode:0o600,flag:'wx'});
   const unprovenTx=Transaction.fromParts(networkId,undefined,undefined,Intent.new(new Date(Date.now()+3600000)).addDeploy(deployment));
   const final=await submitTx(providers,{unprovenTx});finalize(final);
   const confirmed=await providers.publicDataProvider.queryContractState(deployment.address);
   if(!confirmed||confirmed.maintenanceAuthority.committee.length!==0||confirmed.maintenanceAuthority.threshold!==1)throw new Error('immutable authority verification failed');
   return {deployTxData:{public:{...final,contractAddress:deployment.address}}};
  },
  reconcile:async(id:string)=>{const data=await providers.publicDataProvider.watchForTxData(id);finalize(data);return {status:data.status,txId:data.txId,blockHeight:data.blockHeight};},
  call:async(address:string,circuit:'claim'|'redeem'|'addLiquidity'|'swap'|'removeLiquidity',args:unknown[])=>{
   if(journal.list().some(r=>r.stage==='prepared'||r.stage==='sending'||r.stage==='submitted'))throw new Error('Reconcile pending Midnight transactions before another call');
   // This contract has no persistent private application state. Restore its empty
   // witness state when opening an existing deployment in a fresh process.
   await providers.privateStateProvider.setContractAddress(address);
   if(await providers.privateStateProvider.get('bridge')===null)await providers.privateStateProvider.set('bridge',{});
   // The SDK validates user arguments and generated bindings validate circuit shapes.
   const result=await submitCallTx(providers,{compiledContract:compiled,contractAddress:address,privateStateId:'bridge',circuitId:circuit,args:args as never});finalize(result.public);return result;
  },
  close:async()=>{clearInterval(checkpoint);try{await built.save();}finally{await wallet.stop();journal.close();await nodeApi?.disconnect();unlock();}}
 };
}
