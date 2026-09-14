import {WalletSeeds,MidnightWalletProvider,type EnvironmentConfiguration} from '@midnight-ntwrk/testkit-js';
import {InMemoryTransactionHistoryStorage,WalletEntrySchema,mergeWalletEntries,ShieldedWallet,UnshieldedWallet,PublicKey,DustWallet,WalletFacade,createKeystore} from '@midnight-ntwrk/wallet-sdk';
import {LedgerParameters,ZswapSecretKeys,DustSecretKey} from '@midnight-ntwrk/ledger-v8';
import {existsSync,writeFileSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import pino from 'pino';
import {readSecret,statePath} from './environment.js';
type Snapshot={identity:string;network:string;shielded:string;dust:string;unshielded:string};
export async function buildPersistentWallet(env:EnvironmentConfiguration,seed:string){
 const seeds=WalletSeeds.fromMasterSeed(seed),identity=createHash('sha256').update(seed).digest('hex'),file=statePath('wallet-sync.json');
 const prior=existsSync(file)?readSecret<Snapshot>(file):undefined;
 if(prior&&(prior.identity!==identity||prior.network!==env.networkId))throw new Error('wallet snapshot belongs to another identity/network');
 const config={indexerClientConnection:{indexerHttpUrl:env.indexer,indexerWsUrl:env.indexerWS},provingServerUrl:new URL(env.proofServer),networkId:env.walletNetworkId,relayURL:new URL(env.nodeWS),txHistoryStorage:new InMemoryTransactionHistoryStorage(WalletEntrySchema,mergeWalletEntries),costParameters:{feeBlocksMargin:5},batchUpdates:{size:1000,timeout:20,spacing:0}};
 const keystore=createKeystore(seeds.unshielded,env.walletNetworkId),shieldedClass=ShieldedWallet(config),unshieldedClass=UnshieldedWallet(config),dustClass=DustWallet({...config,costParameters:{additionalFeeOverhead:0n,feeBlocksMargin:5}});
 const shielded=prior?shieldedClass.restore(prior.shielded):shieldedClass.startWithSeed(seeds.shielded),unshielded=prior?unshieldedClass.restore(prior.unshielded):unshieldedClass.startWithPublicKey(PublicKey.fromKeyStore(keystore)),dust=prior?dustClass.restore(prior.dust):dustClass.startWithSeed(seeds.dust,LedgerParameters.initialParameters().dust);
 const facade=await WalletFacade.init({configuration:config,shielded:()=>shielded,unshielded:()=>unshielded,dust:()=>dust});
 const provider=await MidnightWalletProvider.withWallet(pino({level:'silent'}),env,facade,ZswapSecretKeys.fromSeed(seeds.shielded),DustSecretKey.fromSeed(seeds.dust),keystore);
 let saving:Promise<void>|undefined;
 const save=()=>saving??=(async()=>{const snapshot={identity,network:env.networkId,shielded:await shielded.serializeState(),dust:await dust.serializeState(),unshielded:await unshielded.serializeState()};const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(snapshot),{mode:0o600});renameSync(tmp,file);})().finally(()=>{saving=undefined;});
 return {provider,save};
}
