import {Address} from '@ton/core';
import {parseMidnightRecipient as parseRecipient} from '../src/midnight-address.js';
import {positiveUint64} from '../src/ton.js';
import type {Deployment,RouteAsset} from './readers.js';

/** An error whose message is safe to show the client. */
export class HttpError extends Error{constructor(readonly status:number,message:string){super(message);}}
const invalid=(message:string)=>new HttpError(400,message);

/** Decimal token amount to integer base units; rejects excess precision. */
export function parseUnits(value:unknown,decimals:number):bigint{
 if(typeof value!=='string'||!/^\d+(\.\d+)?$/.test(value.trim()))throw invalid('Enter an amount like 12.5');
 const [whole,frac='']=value.trim().split('.');if(frac.length>decimals)throw invalid(`At most ${decimals} decimal places`);
 try{return positiveUint64(BigInt(whole!)*10n**BigInt(decimals)+BigInt(frac.padEnd(decimals,'0')||'0'));}catch(e){throw invalid((e as Error).message);}
}
/** Accepts an unshielded preprod bech32m address or the raw 32-byte hex form; refuses zero. */
export function parseMidnightRecipient(value:unknown):Buffer{
 try{return parseRecipient(value,'preprod');}catch(e){throw invalid((e as Error).message);}
}
export function parseTonAddress(value:unknown):Address{
 if(typeof value!=='string'||!value.trim())throw invalid('TON address required');
 let a:Address;try{a=Address.parse(value.trim());}catch{throw invalid('Not a valid TON address');}
 if(a.workChain!==0)throw invalid('Only basechain TON wallets are supported');return a;
}
/** Asset index from JSON (0/1) or a query string ('0'/'1'). */
export function routeFor(d:Deployment,value:unknown):RouteAsset{
 if(value!==0&&value!==1&&value!=='0'&&value!=='1')throw invalid('Unknown asset');return d.assets[Number(value)]!;
}
export function formatUnits(units:bigint,decimals:number):string{
 const s=units.toString().padStart(decimals+1,'0'),f=s.slice(-decimals).replace(/0+$/,'');
 return decimals?`${s.slice(0,-decimals)}${f?'.'+f:''}`:s;
}
