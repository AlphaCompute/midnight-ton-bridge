# Reference-wallet failed-transfer recovery

The standard adapter uses opcode `0x42524704` to restore one existing pending
instruction after a downstream failure. It never chooses a new amount or payee.
Two of the three configured committee members must attest the same evidence.
This adds no trustless failure proof: the committee already authorizes bridge
mint/release, and two colluding members can lie about failure. Independent custody
and review remain required.

## Operator configuration

The JSON file passed to `recover:standard` has these fields:

- `rpc`: trusted TON-testnet v4 endpoint.
- `assets`: the two-entry registry described in the README.
- `escrow`, `codeHash`, `configHash`, `domain`: pins from the route deployment.
- `committee`: three hex Ed25519 public keys, in on-chain order.
- `signer`: this operator's index 0, 1 or 2.
- `keyFile`: absolute owner-only secret JSON path containing `tonSeed`.
- `policy`: `database`, `stopFile`, `maxTransfer`, `maxPerDay`, using absolute
  state paths and decimal-string amounts (see `src/signer-policy.ts`).

The signer checks that the escrow's actual domain, committee, master and wallet
code agree with its configuration before signing. Each operator uses its own
RPC, secret and signing database. Never copy demonstration secrets to production.

The request file is:

```json
{
  "asset": 0,
  "query": "2",
  "trace": {
    "source": {"lt": "SOURCE_LT", "hash": "SOURCE_TX_64_HEX"},
    "rejection": {"lt": "RECIPIENT_LT", "hash": "RECIPIENT_TX_64_HEX"},
    "bounce": {"lt": "BOUNCE_LT", "hash": "BOUNCE_TX_64_HEX"},
    "recipientWallet": "ACTUAL_RECIPIENT_JETTON_WALLET_ADDRESS"
  }
}
```

Obtain these exact transaction locators from the failed transfer's trace. They
are not user-wallet addresses or a wallet sequence number. The observer checks
finality, master/wallet code pins, escrow origin, query/amount, exact message-hash
links, recipient abort with an actual generated bounce, and successful bounce
processing by the source wallet. A timeout, failed API call, insufficient balance
or missing notification is insufficient evidence.

## Relay and retry

1. Both operators run `npm run recover:standard -- CONFIG REQUEST`, saving the
   public outputs as separate attestation JSON files.
2. The relay configuration contains `escrow`, `codeHash`, `configHash`, `domain`,
   `committee`, and optionally `walletKeyFile` for the funded TON sender.
3. Run `npm run relay:failure -- CONFIG A B` to inspect the prepared message.
4. Add `--send` to submit it. The relayer checks both signatures against the
   pending cell fetched from the pinned escrow. It uses the shared wallet lock,
   network pin and durable transaction journal.
5. Reconcile the wallet transaction and verify the pending query is absent and
   the original release marker is cleared (or the original refund is restored).
   Run `npm run reconcile:ton -- all`. Preserve the original failed trace.
6. Retry the **original** authorized release or refund. A new outgoing query is
   allocated. Old restoration signatures cannot restore that new query. Verify
   actual recipient delivery, then run `npm run check:route` after both chains
   settle.

An immediate bounce from the escrow's wallet is restored automatically. A
successful transfer needs no restoration. `excesses` is accepted only as returned
TON; it is never interpreted as proof of delivery. The legacy custom callback is
not accepted by the standard adapter.
