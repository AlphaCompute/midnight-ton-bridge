import {network,readSecret,statePath,stateDirectory} from '../src/environment.js';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {TonClient4,WalletContractV4} from '@ton/ton';
import {Cell,beginCell,internal,toNano} from '@ton/core';
import {keyPairFromSeed} from '@ton/crypto';
import {escrowData,TonContract} from '../src/ton.js';

// Prepare is the default. --send uses an explicitly funded TESTNET wallet.
const send=process.argv.includes('--send');
if(network()==='mainnet'||(send&&network()!=='preprod'))throw new Error('Fixture deployment requires BRIDGE_NETWORK=preprod');
stateDirectory();
const secretPath=statePath('ton-test-wallet.json');
if(!existsSync(secretPath))writeFileSync(secretPath,JSON.stringify({seed:randomBytes(32).toString('hex')}),{mode:0o600,flag:'wx'});
const seed=readSecret<{seed:string}>(secretPath).seed as string;
const keys=keyPairFromSeed(Buffer.from(seed,'hex')),wallet=WalletContractV4.create({workchain:0,publicKey:keys.publicKey});
const code=(name:string)=>Cell.fromBase64(JSON.parse(readFileSync(`build/ton/${name}.json`,'utf8')).codeBoc64);
const committeeFile=process.env.TON_COMMITTEE_FILE;
if(!committeeFile)throw new Error('Set TON_COMMITTEE_FILE to a JSON array of three public Ed25519 key hex strings');
const committee=(JSON.parse(readFileSync(committeeFile,'utf8')) as string[]).map(k=>Buffer.from(k,'hex'));
const domain=process.env.BRIDGE_DOMAIN;if(!domain||!/^[a-f0-9]{64}$/i.test(domain))throw new Error('Set BRIDGE_DOMAIN to the agreed 32-byte route-domain hex');
const walletCode=code('test-wallet'),escrowCode=code('escrow'),minterCode=code('test-minter');
// Different test supply caps make the two fixture minter deployments distinct.
const assets=[0,1].map(asset=>{
 const minter=TonContract.create(minterCode,beginCell().storeAddress(wallet.address).storeRef(walletCode).storeUint(0,64).storeUint(1_000_000_000_000n-BigInt(asset),64).endCell());
 const data=escrowData(Buffer.from(domain,'hex'),committee,minter.address,walletCode),escrow=TonContract.create(escrowCode,data);
 return {asset,minter,escrow,configHash:data.beginParse().loadRef().hash().toString('hex')};
});
const plan={network:'ton-testnet',fundingAddress:wallet.address.toString({testOnly:true}),domain,assets:assets.map(a=>({asset:a.asset,master:a.minter.address.toRawString(),escrow:a.escrow.address.toRawString(),configHash:a.configHash,codeHash:escrowCode.hash().toString('hex')}))};
writeFileSync(statePath('ton-plan.json'),JSON.stringify(plan,null,2));
console.log(JSON.stringify(plan,null,2));
if(send){
 if(existsSync(statePath('ton-deployment-attempt.json')))throw new Error('Prior deployment attempt exists; reconcile wallet sequence and addresses before another attempt');
 const client=new TonClient4({endpoint:'https://testnet-v4.tonhubapi.com'}),opened=client.open(wallet),seqno=await opened.getSeqno();
 const messages=assets.flatMap(a=>[a.minter,a.escrow]).map(c=>internal({to:c.address,value:toNano('0.2'),init:c.init!,body:Cell.EMPTY}));
 const transfer=wallet.createTransfer({seqno,secretKey:keys.secretKey,messages});
 writeFileSync(statePath('ton-deployment-attempt.json'),JSON.stringify({seqno,body:transfer.toBoc().toString('base64'),plan},null,2),{mode:0o600,flag:'wx'});
 await opened.send(transfer);
 console.log('Submitted. Verify all four contract addresses on TON testnet; this is not a finality assertion.');
}
