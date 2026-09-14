// Official zero-state root: https://ton.org/testnet-global.config.json
export const TON_TESTNET_ZERO_STATE='gj+B8wb/AmlPk1z1AhVI484rhrUpgSr2oSFIh56VoSg=';
export function assertTonTestnet(head:{init:{rootHash:string}}){
 if(head.init.rootHash!==TON_TESTNET_ZERO_STATE)throw new Error('RPC is not the pinned TON testnet');
}
