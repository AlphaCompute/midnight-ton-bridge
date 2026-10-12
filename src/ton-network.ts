import {TonClient4} from '@ton/ton';
// Official zero-state root: https://ton.org/testnet-global.config.json
export const TON_TESTNET_ZERO_STATE='gj+B8wb/AmlPk1z1AhVI484rhrUpgSr2oSFIh56VoSg=';
export const TON_TESTNET_RPC='https://testnet-v4.tonhubapi.com';
/** Blocks behind the RPC head that observers treat as final. */
export const TON_FINALITY_DEPTH=3;
const MAX_HEAD_AGE_SECONDS=120;
export function assertTonTestnet(head:{init:{rootHash:string}}){
 if(head.init.rootHash!==TON_TESTNET_ZERO_STATE)throw new Error('RPC is not the pinned TON testnet');
}
/** TON testnet v4 client; `TON_RPC_URL` overrides the public endpoint. */
export const tonClient=(options:{endpoint?:string;timeout?:number}={})=>new TonClient4({endpoint:options.endpoint??process.env.TON_RPC_URL??TON_TESTNET_RPC,...options.timeout?{timeout:options.timeout}:{}});
/** Pinned-testnet, recent head and the block `depth` behind it. Trusted-RPC reads only. */
export async function finalizedBlock(client:Pick<TonClient4,'getLastBlock'>,depth=TON_FINALITY_DEPTH){
 if(!Number.isSafeInteger(depth)||depth<1)throw new Error('invalid confirmation depth');
 const head=await client.getLastBlock();assertTonTestnet(head);
 if(Math.abs(Date.now()/1000-head.now)>MAX_HEAD_AGE_SECONDS)throw new Error('stale TON RPC head');
 const block=head.last.seqno-depth;if(block<1)throw new Error('chain not ready');
 return {head,block};
}
