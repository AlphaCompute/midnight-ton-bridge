import {openTon} from '../src/live-ton.js';
import {internal} from '@ton/core';
import {statePath} from '../src/environment.js';
import {readFileSync} from 'node:fs';
import {Address,beginCell,toNano} from '@ton/core';
import {uint64} from '../src/ton.js';
const [asset,amount,to]=process.argv.slice(2);if(!['0','1'].includes(asset??'')||!amount||!to)throw new Error('usage: npm run mint:ton -- ASSET_0_OR_1 BASE_UNITS RECIPIENT');
const plan=JSON.parse(readFileSync(statePath('ton-plan.json'),'utf8')) as {network:string;fundingAddress:string;assets:{master:string}[]};
if(plan.network!=='ton-testnet')throw new Error('testnet only');
const body=beginCell().storeUint(0x4d494e54,32).storeAddress(Address.parse(to)).storeUint(uint64(BigInt(amount)),64).endCell();
console.log(JSON.stringify({network:'ton-testnet',sendFrom:plan.fundingAddress,to:plan.assets[Number(asset)]!.master,value:toNano('0.2').toString(),body:body.toBoc().toString('base64'),note:'Owner-only synthetic test mint. Send from the original deployment wallet; not an official USD1 issuer operation.'},null,2));

if(process.argv.includes('--send')){const ton=openTon();console.log(await ton.send(`mint:${asset}:${amount}:${Address.parse(to).toRawString()}`,[internal({to:Address.parse(plan.assets[Number(asset)]!.master),value:toNano('0.2'),body})]));}
