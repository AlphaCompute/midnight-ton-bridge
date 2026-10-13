import {network,readJson} from '../src/environment.js';
import {toJson} from '../src/encoding.js';
import {BridgeClient,type BridgeConfig,type ClaimAttestation} from '../src/sdk.js';
import {type DepositReceipt,type EscrowPins,verifyEscrowPins} from '../src/escrow.js';
import {type RedemptionRequest} from '../src/redemptions.js';
import {Address,toNano,internal,type Cell} from '@ton/core';
import {signVerify} from '@ton/crypto';
import {releaseBody,releaseDigest} from '../src/ton.js';
import {failureBody,failureDigest,unrecordedBody,unrecordedDigest} from '../src/jettons.js';
import {finalizedBlock,tonClient} from '../src/ton-network.js';
import {flag} from './lib/util.js';

// Relays two committee attestations. Without --send it only verifies and prints the
// prepared transaction; it never opens a wallet or wallet state.
const [command,path,aPath,bPath]=process.argv.slice(2);
if(!path||!aPath||!bPath)throw new Error('usage: npm run relay -- claim|release|recovery CONFIG ATTESTATION_A ATTESTATION_B [--send]');
const send=flag('--send');
type TonAttestation={signer:number;signature:string};
/** Two attestations from distinct committee slots, ascending, each signing `digest`. */
function tonQuorum<T extends TonAttestation>(entries:T[],committee:string[],digest:Buffer){
 const [a,b]=[...entries].sort((x,y)=>x.signer-y.signer);
 if(!a||!b||!Number.isInteger(a.signer)||!Number.isInteger(b.signer)||a.signer<0||a.signer>=b.signer||b.signer>2)throw new Error('invalid quorum');
 for(const e of [a,b])if(!signVerify(digest,Buffer.from(e.signature,'hex'),Buffer.from(committee[e.signer]??'','hex')))throw new Error('invalid signature');
 return {a,b,sigA:Buffer.from(a.signature,'hex'),sigB:Buffer.from(b.signature,'hex')};
}
/** Prints the prepared escrow message, or with --send submits it from the journaled wallet. */
async function relayToEscrow(escrow:Address,body:Cell,id:string,walletKeyFile?:string,options:{afterConfirmed?:boolean}={}){
 if(!send){console.log(JSON.stringify({network:'ton-testnet',to:escrow.toRawString(),value:toNano('0.2').toString(),body:body.toBoc().toString('base64')}));return;}
 if(network()!=='preprod')throw new Error('live TON relays require BRIDGE_NETWORK=preprod');
 // Wallet providers open state; only --send needs them.
 const {openTon}=await import('../src/live-ton.js');
 console.log(await openTon(walletKeyFile).send(id,[internal({to:escrow,value:toNano('0.2'),body})],options));
 console.log('Submitted; reconcile the full jetton trace before asserting delivery.');
}
if(command==='claim'){
 const config=readJson<BridgeConfig>(path);config.committee=config.committee.map(p=>({x:BigInt(p.x),y:BigInt(p.y)})) as BridgeConfig['committee'];
 const entries=[readJson(aPath),readJson(bPath)] as {receipt:DepositReceipt;attestation:ClaimAttestation}[];
 const canonical=(r:DepositReceipt)=>JSON.stringify([r.id,r.network,Address.parse(r.escrow).toRawString(),r.sequence,r.asset,r.amount,r.recipient]);
 if(canonical(entries[0]!.receipt)!==canonical(entries[1]!.receipt))throw new Error('observers did not agree on the same transfer');
 for(const {attestation:a} of entries){a.signature.response=BigInt(a.signature.response);a.signature.announcement={x:BigInt(a.signature.announcement.x),y:BigInt(a.signature.announcement.y)};}
 if(!send){
  const bridge=new BridgeClient(config,{call:async(circuit,args)=>toJson({network:config.network,address:config.midnightAddress,circuit,args},0)});
  console.log(await bridge.claim(entries[0]!.receipt,entries.map(x=>x.attestation)));
 }else{
  // Only submission opens a wallet, so only it must match the configured network.
  if(network()!==config.network)throw new Error('provider network differs from bridge config');
  const {openMidnight}=await import('../src/live-midnight.js'),client=await openMidnight();
  try{const bridge=new BridgeClient(config,{call:async(c,args)=>{const r=await client.call(config.midnightAddress,c,args);return r.public.txId;}});console.log(await bridge.claim(entries[0]!.receipt,entries.map(x=>x.attestation)));}finally{await client.close();}
 }
}else if(command==='release'){
 const config=readJson<{network:string;domain:string;escrows:[string,string];committee:string[];walletKeyFile:string}>(path);
 if(config.network!=='ton-testnet')throw new Error('testnet only');
 const entries=[readJson(aPath),readJson(bPath)] as (TonAttestation&{request:RedemptionRequest})[];
 if(JSON.stringify(entries[0]!.request)!==JSON.stringify(entries[1]!.request))throw new Error('observers disagree');
 const r=entries[0]!.request;if(r.asset!==0&&r.asset!==1)throw new Error('invalid asset');
 if(!/^[0-9a-f]{64}$/i.test(r.id))throw new Error('invalid redemption id');
 const escrow=Address.parse(config.escrows[r.asset]),recipient=Address.parse(r.recipient),amount=BigInt(r.amount),id=Buffer.from(r.id,'hex');
 const q=tonQuorum(entries,config.committee,releaseDigest(escrow,Buffer.from(config.domain,'hex'),id,amount,recipient));
 // The escrow marks a release active when it accepts it and clears the mark only on a
 // restore. While inactive, resending the same signed release is safe (the escrow's replay
 // guard still admits it once), including after an earlier confirmed send it restored.
 let afterConfirmed=false;
 if(send){
  const client=tonClient(),{block}=await finalizedBlock(client),state=await client.runMethod(block,escrow,'releaseState',[{type:'int',value:BigInt('0x'+r.id)}]);
  if(state.exitCode!==0)throw new Error('releaseState unavailable');
  if(state.reader.readNumber()!==0)throw new Error('Release is already active on chain; verify recipient delivery instead of resending');
  afterConfirmed=true;
 }
 await relayToEscrow(escrow,releaseBody(id,amount,recipient,q.a.signer,q.b.signer,q.sigA,q.sigB),`release:${escrow.toRawString()}:${r.id.toLowerCase()}`,config.walletKeyFile,{afterConfirmed});
}else if(command==='recovery'){
 // Restores a downstream-failed transfer or refunds an unrecorded credit (operator attest-recovery output).
 const c=readJson<EscrowPins&{domain:string;committee:string[];walletKeyFile?:string}>(path);
 const entries=[readJson(aPath),readJson(bPath)] as (TonAttestation&{kind?:string;query?:string;evidence:string;amount?:string;from?:string})[];
 const [x,y]=entries as [typeof entries[0],typeof entries[0]];
 if(x.kind!==y.kind||x.query!==y.query||x.evidence!==y.evidence||x.amount!==y.amount||x.from!==y.from)throw new Error('Invalid or disagreeing quorum');
 const client=tonClient(),escrow=Address.parse(c.escrow),{block}=await finalizedBlock(client);await verifyEscrowPins(client,block,c);
 const evidence=Buffer.from(x.evidence,'hex'),domain=Buffer.from(c.domain,'hex');
 if(x.kind==='unrecorded'){
  const from=Address.parse(x.from!),amount=BigInt(x.amount!);
  const q=tonQuorum(entries,c.committee,unrecordedDigest(escrow,domain,evidence,amount,from));
  await relayToEscrow(escrow,unrecordedBody(evidence,amount,from,q.a.signer,q.b.signer,q.sigA,q.sigB),`unrecorded:${escrow.toRawString()}:${x.evidence}`,c.walletKeyFile);
 }else{
  const result=await client.runMethod(block,escrow,'pending',[{type:'int',value:BigInt(x.query!)}]);if(result.exitCode!==0)throw new Error('No pending instruction');
  const q=tonQuorum(entries,c.committee,failureDigest(escrow,domain,BigInt(x.query!),evidence,result.reader.readCell()));
  await relayToEscrow(escrow,failureBody(BigInt(x.query!),evidence,q.a.signer,q.b.signer,q.sigA,q.sigB),`restore:${escrow.toRawString()}:${x.query}`,c.walletKeyFile);
 }
}else throw new Error('unknown relay command');
