import {beginCell,Cell,type Address,type Transaction} from '@ton/core';
import {Blockchain,type SandboxContract} from '@ton/sandbox';
import {TonContract,escrowData,releaseDigest,releaseBody} from '../../src/ton.js';
import {referenceWallet,referenceMintBody,type JettonAsset} from '../../src/jettons.js';
import {TON_COMMITTEE,compiled,quorumSign,overrideWalletData} from './ton.js';
import {sandboxRpc} from './ton-rpc.js';

export const STANDARD_DOMAIN=Buffer.alloc(32,77);
/** Reference TEP-74 jetton, a standard escrow capped at `cap`, and a user holding 10000 tokens. */
export async function route(cap=1000n){
 const domain=STANDARD_DOMAIN,[wc,mc,ec]=await Promise.all([compiled('reference-wallet'),compiled('reference-minter'),compiled('escrow-standard')]);
 const chain=await Blockchain.create(),owner=await chain.treasury('owner'),user=await chain.treasury('user'),attacker=await chain.treasury('attacker');
 const master=chain.openContract(TonContract.create(mc,beginCell().storeCoins(0).storeAddress(owner.address).storeRef(Cell.EMPTY).storeRef(wc).endCell()));await master.send(owner.getSender());
 const config=escrowData(domain,TON_COMMITTEE,master.address,wc,cap),escrow=chain.openContract(TonContract.create(ec,config));await escrow.send(owner.getSender());
 await master.send(owner.getSender(),referenceMintBody(user.address,10000n));
 const wallet=chain.openContract(referenceWallet(user.address,master.address,wc)),escrowWallet=chain.openContract(referenceWallet(escrow.address,master.address,wc));
 const asset:JettonAsset={asset:0,symbol:'TOKEN',decimals:6,master:master.address.toRawString(),masterCodeHash:mc.hash().toString('hex'),walletCodeBoc:wc.toBoc().toString('base64'),walletCodeHash:wc.hash().toString('hex'),cap:cap.toString(),adapter:'tep74-reference'};
 let history:Transaction[]=[];const client=sandboxRpc(chain,()=>history);
 const balance=async(w:SandboxContract<TonContract>)=>w.getNumber('get_wallet_data');
 const release=(id:Buffer,amount:bigint,to:Address,a=0,b=2)=>{const [sa,sb]=quorumSign(releaseDigest(escrow.address,domain,id,amount,to),a,b);return releaseBody(id,amount,to,a,b,sa,sb);};
 /** Overwrite a reference wallet's balance; returns a restore function. */
 const setBalance=(w:Address,holder:Address,amount:bigint)=>overrideWalletData(chain,w,beginCell().storeCoins(amount).storeAddress(holder).storeAddress(master.address).storeRef(wc).endCell());
 return {chain,domain,owner,user,attacker,master,escrow,wallet,escrowWallet,asset,client,balance,release,setBalance,ec,wc,mc,configHash:config.beginParse().loadRef().hash().toString('hex'),setHistory:(h:Transaction[])=>{history=h;}};
}
export type Route=Awaited<ReturnType<typeof route>>;
