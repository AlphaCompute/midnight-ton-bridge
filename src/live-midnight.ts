import {ApiPromise,WsProvider} from '@polkadot/api';
import {firstValueFrom,filter,timeout} from 'rxjs';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {inMemoryPrivateStateProvider,type EnvironmentConfiguration} from '@midnight-ntwrk/testkit-js';
import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id';
import {indexerPublicDataProvider} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {NodeZkConfigProvider} from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {httpClientProofProvider} from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import {CompiledContract} from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import {createUnprovenDeployTx,submitTx,submitCallTx} from '@midnight-ntwrk/midnight-js-contracts';
import {sampleSigningKey,ContractState,ContractDeploy,ContractMaintenanceAuthority,Transaction,Intent,unshieldedToken} from '@midnight-ntwrk/ledger-v8';
import {Contract} from '../build/midnight/contract/index.js';
import {openPersistentWallet} from './midnight-wallet.js';
import {acquireLock,network as configuredNetwork,readSecret,statePath} from './environment.js';
import {witnesses,type CircuitName} from './midnight.js';
import {Journal} from './journal.js';
import {midnightEndpoints} from './midnight-endpoints.js';
import {installWebSocket,midnightNetworkId} from './midnight-indexer.js';

export async function openMidnight(options:{waitForFunds?:boolean}={}){
 const network=configuredNetwork();
 if(network!=='local'&&network!=='preprod')throw new Error('test networks only');
 const local=network==='local',networkId=midnightNetworkId(network);
 const env:EnvironmentConfiguration={walletNetworkId:networkId,networkId,...midnightEndpoints(network),faucet:undefined};
 // Public-network seeds come only from an owner-only file; a raw MIDNIGHT_SEED is a local convenience.
 if(!local&&process.env.MIDNIGHT_SEED)throw new Error('MIDNIGHT_SEED is local-only; use an owner-only MIDNIGHT_SEED_FILE');
 const seed=local?process.env.MIDNIGHT_SEED??'0'.repeat(63)+'1':readSecret<{seed:string}>(process.env.MIDNIGHT_SEED_FILE??statePath('midnight-test-wallet.json')).seed;
 if(!seed||!/^[a-f0-9]{64}$/i.test(seed))throw new Error('Midnight wallet seed must be 32-byte hex');
 setNetworkId(networkId);installWebSocket();
 // Released on any exit, including SDK crashes from unhandled socket errors; journals,
 // not this lock, guard against duplicate transactions.
 const release=acquireLock(statePath('midnight-wallet.lock'),{network:networkId}),unlock=()=>{process.off('exit',unlock);release();};process.once('exit',unlock);
 let journal:Journal,built:Awaited<ReturnType<typeof openPersistentWallet>>;
 try{journal=new Journal(statePath('midnight-transactions.sqlite'));}catch(error){unlock();throw error;}
 try{built=await openPersistentWallet(env,seed);}catch(error){journal.close();unlock();throw error;}
 const wallet=built.provider;
 const checkpoint=setInterval(()=>{void built.save().catch(e=>console.error('Wallet checkpoint failed:',String(e)));},60000);
 checkpoint.unref();
 const assertSettled=(action:string)=>{if(journal.pending().length)throw new Error(`Reconcile pending Midnight transactions before ${action}`);};
 const path=resolve('build/midnight');
 const zkConfigProvider=new NodeZkConfigProvider<CircuitName>(path);
 let nodeApi:ApiPromise|undefined;
 const providers={privateStateProvider:inMemoryPrivateStateProvider<string,Record<string,never>>(),
  publicDataProvider:indexerPublicDataProvider(env.indexer,env.indexerWS),zkConfigProvider,
  proofProvider:httpClientProofProvider(env.proofServer,zkConfigProvider),walletProvider:wallet,
  midnightProvider:{submitTx:async(tx:Parameters<typeof wallet.submitTx>[0],purpose='midnight signed transaction')=>{
   const id=tx.identifiers()[0];if(!id)throw new Error('transaction has no identifier');
   const raw=Buffer.from(tx.serialize()).toString('hex');
   const previous=journal.get(id);
   if(previous)throw new Error(`transaction ${id} already journaled; reconcile before retrying`);
   journal.observe(id,purpose);journal.move(id,'observed','prepared',{tx:raw,txid:id});
   let send:NonNullable<ApiPromise['tx']['midnight']>['sendMnTransaction'];
   try{
    await wallet.wallet.pendingTransactionsService.addPendingTransaction(tx);
    // @ts-expect-error Polkadot WsProvider's optional ttl differs under exactOptionalPropertyTypes.
    nodeApi??=await ApiPromise.create({provider:new WsProvider(env.nodeWS),noInitWarn:true});
    const extrinsic=nodeApi.tx.midnight?.sendMnTransaction;if(!extrinsic)throw new Error('node lacks Midnight transaction extrinsic');send=extrinsic;
   }catch(error){
    // Nothing has left this process yet, so the entry is provably dead rather than ambiguous.
    journal.move(id,'prepared','rejected',{error:`not broadcast: ${String(error)}`});throw error;
   }
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
    assertSettled('DUST registration');
    const coins=state.unshielded.availableCoins.filter(c=>c.utxo.type===unshieldedToken().raw&&!c.meta.registeredForDustGeneration);
    if(coins.length){
     const recipe=await wallet.wallet.registerNightUtxosForDustGeneration(coins,wallet.unshieldedKeystore.getPublicKey(),p=>wallet.unshieldedKeystore.signData(p));
     const tx=await wallet.wallet.finalizeRecipe(recipe),id=await providers.midnightProvider.submitTx(tx,'DUST registration');
     const result=await providers.publicDataProvider.watchForTxData(id);journal.move(id,'submitted',result.status==='SucceedEntirely'?'confirmed':'rejected',{error:result.status==='SucceedEntirely'?null:result.status});
     if(result.status!=='SucceedEntirely')throw new Error('DUST registration failed');
    }
    await firstValueFrom(wallet.wallet.state().pipe(filter(s=>s.dust.state.progress.isStrictlyComplete()&&s.dust.balance(new Date())>0n),timeout(300000)));
   }
  }
 }catch(error){clearInterval(checkpoint);await built.save().catch(()=>{});await wallet.stop().catch(()=>{});journal.close();await nodeApi?.disconnect();unlock();throw error;}
 const finalize=(data:{status:string;identifiers:readonly string[]})=>{
  const ok=data.status==='SucceedEntirely';
  for(const id of data.identifiers){const row=journal.get(id);if(row&&(row.stage==='sending'||row.stage==='submitted'))journal.move(id,row.stage,ok?'confirmed':'rejected',{error:ok?null:data.status});}
  if(!ok)throw new Error(`Midnight transaction failed: ${data.status}`);
 };
 return {wallet,providers,compiled,env,journal,
  deploy:async(domain:Uint8Array,keys:Parameters<Contract['initialState']>[2],cap:bigint)=>{
   assertSettled('deploying');
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
  // Absence within the wait is not rejection; the entry stays pending for a later reconcile.
  reconcile:async(id:string,waitMs=120000)=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   const data=await Promise.race([providers.publicDataProvider.watchForTxData(id),new Promise<null>(r=>{timer=setTimeout(()=>r(null),waitMs);})]).finally(()=>clearTimeout(timer));
   if(!data)return {status:'pending' as const,txId:id};
   finalize(data);return {status:data.status,txId:data.txId,blockHeight:data.blockHeight};
  },
  call:async(address:string,circuit:CircuitName,args:unknown[])=>{
   assertSettled('another call');
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
