import {existsSync,writeFileSync} from 'node:fs';
import {Address,beginCell,Cell,internal,toNano} from '@ton/core';
import {openTon} from '../src/live-ton.js';
import {network,readJson,routeDomain,statePath} from '../src/environment.js';
import {BRIDGE_CAP,escrowData,TonContract} from '../src/ton.js';
import {validateAssets,verifyAsset,type JettonAsset} from '../src/jettons.js';
import {flag,loadTonCode} from './lib/util.js';

// Prepares (and with --send deploys) the two reference-wallet escrows of a route.
if(network()!=='preprod')throw new Error('Deployments in this release target testnet only');
const t=openTon(),send=flag('--send'),issue=flag('--issue-testnet-tokens');
const domain=routeDomain().toString('hex');
if(!process.env.TON_COMMITTEE_FILE)throw new Error('Set TON_COMMITTEE_FILE to a JSON array of three public Ed25519 key hex strings');
const committee=readJson<string[]>(process.env.TON_COMMITTEE_FILE).map(k=>Buffer.from(k,'hex'));
let assets:JettonAsset[];const minters:TonContract[]=[];
if(issue){
 if(process.env.BRIDGE_ASSETS_FILE)throw new Error('Do not combine existing assets with token issuance');
 const wc=loadTonCode('reference-wallet'),mc=loadTonCode('reference-minter');
 assets=([0,1] as const).map(asset=>{
  const content=beginCell().storeUint(1,8).storeStringTail(`https://example.invalid/bridge-testnet/${domain}/${asset}.json`).endCell();
  const minter=TonContract.create(mc,beginCell().storeCoins(0).storeAddress(t.wallet.address).storeRef(content).storeRef(wc).endCell());minters.push(minter);
  return {asset,symbol:`BRIDGE-${asset}`,decimals:6,master:minter.address.toRawString(),masterCodeHash:mc.hash().toString('hex'),walletCodeBoc:wc.toBoc().toString('base64'),walletCodeHash:wc.hash().toString('hex'),cap:BRIDGE_CAP.toString(),adapter:'tep74-reference'};
 });
}else{
 if(!process.env.BRIDGE_ASSETS_FILE)throw new Error('Set BRIDGE_ASSETS_FILE to approved assets; token issuance requires explicit --issue-testnet-tokens');
 assets=validateAssets(readJson(process.env.BRIDGE_ASSETS_FILE));
}
if(assets.some(a=>BigInt(a.cap)>BRIDGE_CAP))throw new Error('TON cap exceeds this release Midnight deployment cap');
const ec=loadTonCode('escrow-standard');
const contracts=assets.map(a=>TonContract.create(ec,escrowData(Buffer.from(domain,'hex'),committee,Address.parse(a.master),Cell.fromBase64(a.walletCodeBoc),BigInt(a.cap))));
if(!issue)for(const [i,a]of assets.entries())await verifyAsset(t.client,a,contracts[i]!.address);
const plan={network:'ton-testnet',adapter:'tep74-reference',testnetIssuance:issue,fundingAddress:t.wallet.address.toString({testOnly:true}),domain,assets:assets.map((a,i)=>({...a,escrow:contracts[i]!.address.toRawString(),codeHash:ec.hash().toString('hex'),configHash:contracts[i]!.init!.data.beginParse().loadRef().hash().toString('hex')}))};
const p=statePath('ton-plan.json');if(existsSync(p)&&JSON.stringify(readJson(p))!==JSON.stringify(plan))throw new Error('Existing route differs; use a new state directory and preserve prior funds');
writeFileSync(p,JSON.stringify(plan,null,2));console.log(JSON.stringify(plan,null,2));
if(send){
 const all=[...minters,...contracts];
 console.log(await t.send(`deploy-standard:${domain}`,all.map(c=>internal({to:c.address,value:toNano('0.2'),init:c.init!,body:Cell.EMPTY}))));
 console.log('Submitted. Run verify:ton after finality; wallet inclusion alone is not deployment verification.');
}
