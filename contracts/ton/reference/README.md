# TON reference jettons

Unmodified sources from https://github.com/ton-blockchain/token-contract at commit
`1182ad99413242f09925d50e70ccb7e0e09f94d4`, under the included MIT license.
Compiled with the pinned `@ton-community/func-js` dependency. These contracts
exercise interoperability without the bridge's custom wallet callback or storage.
The minter is used only to issue valueless tokens on testnet; the bridge deployment
for existing assets does not deploy a minter or require mint authority.

This wallet has the original reference storage layout. TEP-74 standardizes interfaces,
not storage: other wallet implementations require a separate reviewed adapter.
