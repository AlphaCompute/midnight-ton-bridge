# Operator runbook

Deployment commands are in the [deployment guide](deployment.md). This document covers custody, signing, relay, reconciliation, recovery and monitoring. The code does not assign or finance ongoing operations.

## State and custody

`BRIDGE_NETWORK=local` uses `.state`; `preprod` uses `.state/preprod`. `BRIDGE_STATE_DIR` overrides the directory deliberately. Never share a directory across identities/networks or run concurrent Midnight wallet processes against it. Secret JSON files must be owner-only (`chmod 600`), directories should be mode 700. Back up journals, seed files, wallet checkpoints and LP secrets securely. Do not copy them into delivery artifacts.

The new Midnight deployment has no usable maintenance authority. Keep its candidate, intent and confirmed record: these identify an interrupted deployment. Old development deployments with different verifiers/authorities remain separate routes. Never replace a deployed verifier file locally and assume the chain changed. Archive each route's deployment and transaction records, including routes still holding collateral.

Generate one operator per independent custodian with `npm run operator -- keygen PRIVATE_DIRECTORY`. Distribute only `public.json`. The three centrally held `demo-operators.json` keys are for disposable testnet demonstrations only. Never copy demonstration secrets to production.

## Signing policies

Deposit signer configuration:

```json
{
  "rpc": "https://testnet-v4.tonhubapi.com",
  "source": {"escrow":"0:...", "asset":0, "codeHash":"...", "configHash":"...", "confirmationDepth":3},
  "bridge": {"network":"preprod", "domain":"...", "midnightAddress":"...", "escrows":["0:...","0:..."], "committee":[{"x":"...","y":"..."},{"x":"...","y":"..."},{"x":"...","y":"..."}]},
  "signer":0,
  "keyFile":"/private/operator/secret.json",
  "policy":{"maxTransfer":"10000","maxPerDay":"100000","stopFile":"/private/operator/STOP","database":"/private/operator/signing.sqlite"}
}
```

Use reviewed real public values, not the placeholders. Each signer independently runs `npm run operator -- attest-deposit CONFIG SEQUENCE`. It checks a recent TON head, reads an older snapshot, pins escrow code/config, verifies its own committee key, reserves quota and signs the circuit digest. Keep output attestations as public evidence, without keys. Policies are in raw base units; configure them for the selected asset/route.

Reverse signer configuration contains `network`, `indexer`, `indexerWS`, Midnight `address`, deployment `pins`, the three TON public-key hex strings in `committee`, `signer`, `keyFile` and the same `policy` object, plus two `escrows` entries, one per asset in order, each `{"escrow","codeHash","configHash","master"}` copied from the TON deployment plan. Optional `node` (Midnight node RPC) and `tonRpc` default to the network's endpoints. Run `npm run operator -- attest-redemption CONFIG REQUEST_JSON`. Request fields are `id`, `asset`, decimal `amount`, basechain `recipient` and finalized Midnight `transactionId`. `id` is the public retirement ID `bridge.redemptionId(nonce)` (the `redeem` call itself returns only its transaction ID); never share the private nonce. Before signing, the signer checks that the transaction succeeded, that the node reports its block as finalized and canonical, the contract state at that block (verifier, authority and domain pins, exact retirement commitment), and that both escrows run pinned code for this route's domain, committee and token masters.

Create each configured stop file to halt new signing. Quota is reserved before signature exposure and identical retries are idempotent. A different digest for the same receipt is refused. Do not erase signing history to bypass a limit or conflict. Already issued signatures remain usable.

## Relay and reconciliation

`npm run relay -- claim BRIDGE_CONFIG A.json B.json` requires two identical canonical receipts and different valid signers. It validates and prints the prepared claim without opening a wallet. Add `--send` to submit to the matching Midnight network and check successful finalization.

`npm run relay -- release TON_CONFIG A.json B.json` verifies both signatures and prints the prepared release message without a wallet key. Add `--send` with `BRIDGE_NETWORK=preprod` to broadcast. TON_CONFIG contains `network: "ton-testnet"`, `domain`, two `escrows`, three TON `committee` keys and owner-only `walletKeyFile`. Signed bytes are persisted first. Treat submission as pending.

**If a run is interrupted, do not delete journals or rerun blindly.** A wallet sequence change or `releaseState == 1` alone is not recipient delivery. Preserve evidence, reconcile the exact transaction, and resume only the unfinished step after determining whether it executed.

Journal stages are `observed → prepared → sending → submitted → confirmed/rejected`. `sending` can mean a successful broadcast followed by a lost response. For Midnight, run `npm run reconcile:midnight -- EXACT_TRANSACTION_ID` against its original state/network. It waits up to `RECONCILE_WAIT_MS` (default 120000) and exits with status 2 while the transaction is still unknown; the entry stays pending. Do not recreate a transaction from the business request. A timeout or unknown result is not rejection.

For the `openTon` journal, run `npm run reconcile:ton -- ID` (or `all`) to locate the exact external wallet message by its saved body hash in an older chain snapshot. A `prepared` entry was never broadcast (sends enter `sending` before broadcast), so it is marked `rejected` directly. A located message confirms wallet execution only; recipient delivery still requires the jetton trace. A message that is not found is marked `rejected` only when it is provably dead: at the latest finalized block the wallet still has not consumed the message's sequence and the block time is more than 60 seconds past the signed `valid_until`. Anything else stays unresolved. A later `send` with the same logical ID then records a new numbered attempt (`ID#2`, …); this is refused while any earlier attempt is not `rejected`. A new TON send ID likewise cannot bypass an earlier prepared or ambiguous send, and submitted sends reserve their wallet sequence until the on-chain sequence advances.

For TON, preserve the recorded wallet, sequence, body hash and signed BOC. Find the wallet transaction containing that body, then follow the escrow request and outgoing jetton internal transfer. `verifyJettonDelivery` in `src/ton-traces.ts` compares the source outgoing message to the recipient incoming message and checks both transaction executions at an older snapshot. It examines recent history; archive/older traces require an explicit historical query. `releaseState(id)==1` only records submission to the wallet. Never mark a payout confirmed from an account balance alone.

`openTon().send` serializes sends with `ton-wallet.lock`. It relays the same signed message through the reading RPC and every `TON_BROADCAST_URLS` endpoint (toncenter by default), because one RPC can serve reads while silently dropping sends. Each endpoint must first report the pinned TON testnet zero state from its `getMasterchainInfo`, since a wallet signature does not commit to a network and a mainnet endpoint could execute it for a reused key; the wallet sequence admits the message once, and the send counts as submitted if any endpoint accepts it. A stale lock after a crash must be removed only after verifying that no process owns the wallet and reconciling its journal. A fresh wallet sequence is not permission to duplicate an already executed transfer.

Run `npm run check:route` after settled operations and after reconciling journals. It compares backing and circulation, checks code/configuration pins and reports unreconciled `prepared`, `sending` or `submitted` journal entries (`rejected` entries are settled). Differences can represent in-flight deposits/refunds or a real accounting problem; do not repair them with unverified claims.

## Refunds

Malformed or cap-exceeding authenticated deposits create an exact refund record. Query `refundCount` and `refund(id)`, then relay SDK `refundBody(id)` to the escrow with at least 0.15 TON. Anyone can relay it; only the recorded sender is paid. Repeated/nonexistent IDs fail. There is no unrestricted recovery opcode.

Direct issuer mints into an escrow and unsupported production token paths may still lack a receipt. Do not manufacture a claim or infer recoverable surplus from balance minus `locked`. Preserve the trace and resolve the unsupported transfer through an agreed, independently reviewed asset-specific design. Never deploy a general administrator drain as a convenience repair.

## Recovery

The reference-wallet adapter has two committee-attested recovery operations: restoring one existing pending transfer after a downstream failure (opcode `0x42524704`) and refunding an unrecorded jetton credit to its sender (opcode `0x42524705`). Neither chooses a new amount or payee. Two of the three configured committee members must attest the same evidence. This adds no trustless failure proof: the committee already authorizes bridge mint/release, and two colluding members can lie about failure. Independent custody and review remain required.

An immediate bounce from the escrow's wallet is restored automatically. A successful transfer needs no restoration. `excesses` is accepted only as returned TON; it is never interpreted as proof of delivery.

### Recovery signer configuration

The JSON configuration passed to `npm run operator -- attest-recovery CONFIG REQUEST` has these fields:

- `rpc`: trusted TON-testnet v4 endpoint.
- `assets`: the two-entry registry described in [token masters](deployment.md#configure-token-masters).
- `escrow`, `codeHash`, `configHash`, `domain`: pins from the route deployment.
- `committee`: three hex Ed25519 public keys, in on-chain order.
- `signer`: this operator's index 0, 1 or 2.
- `keyFile`: absolute owner-only secret JSON path containing `tonSeed`.
- `policy`: `database`, `stopFile`, `maxTransfer`, `maxPerDay`, using absolute
  state paths and decimal-string amounts (see `src/signer-policy.ts`).

The signer checks that the escrow's actual domain, committee, master and wallet code agree with its configuration before signing. Each operator uses its own RPC, secret and signing database.

The relay configuration for `npm run relay -- recovery CONFIG A B [--send]` contains `escrow`, `codeHash`, `configHash`, `domain`, `committee`, and optionally `walletKeyFile` for the funded TON sender. Without `--send` the relayer verifies both attestations against the pinned escrow (through a TON RPC) and prints the prepared message; it needs no wallet key or `BRIDGE_NETWORK=preprod`. With `--send` it uses the shared wallet lock, network pin and durable transaction journal.

### Downstream transfer failure

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

Obtain these exact transaction locators from the failed transfer's trace. They are not user-wallet addresses or a wallet sequence number. The observer checks finality, master/wallet code pins, escrow origin, query/amount, exact message-hash links, recipient abort with an actual generated bounce, and successful bounce processing by the source wallet. A timeout, failed API call, insufficient balance or missing notification is insufficient evidence.

1. Both operators run `npm run operator -- attest-recovery CONFIG REQUEST`, saving the public outputs as separate attestation JSON files.
2. Run `npm run relay -- recovery CONFIG A B` to inspect the prepared message. The relayer checks both signatures against the pending cell fetched from the pinned escrow.
3. Add `--send` to submit it.
4. Reconcile the wallet transaction (`npm run reconcile:ton -- all`) and verify the pending query is absent and the original release marker is cleared (or the original refund is restored). Preserve the original failed trace.
5. Retry the **original** authorized release or refund. A new outgoing query is allocated. Old restoration signatures cannot restore that new query. Verify actual recipient delivery, then run `npm run check:route` after both chains settle.

### Unrecorded credits (opcode `0x42524705`)

A jetton transfer to the escrow that forwards too little TON (wallet apps often forward 1 nanoton) or none at all credits the escrow's jetton wallet without a deposit or refund record. `check:route` shows this as a balance above `locked`. Two committee members can turn exactly that credit into a normal refund to its original sender. They cannot choose the amount or payee, and each credit transaction can be used once.

Request file for `attest-recovery` (same signer configuration as above):

```json
{
  "asset": 0,
  "kind": "unrecorded",
  "trace": {
    "credit": {"lt": "ESCROW_WALLET_LT", "hash": "ESCROW_WALLET_TX_64_HEX"},
    "notification": {"lt": "ESCROW_LT", "hash": "ESCROW_TX_64_HEX"}
  }
}
```

`credit` is the escrow jetton wallet's transaction that received the internal transfer. `notification` is the escrow's transaction for the resulting transfer notification; omit it only when the transfer forwarded zero TON. The signer checks that the sender's own reference wallet sent the credit, that the escrow did not successfully process the notification, that the amount fits uint64 and that the escrow has not already recovered this credit. Relay both attestations with `npm run relay -- recovery CONFIG A B [--send]`. Then pay the new refund with `refundBody(refundCount - 1)` as for any [refund](#refunds). `npm run demo:unrecorded` exercises this path on testnet.

## Monitoring

Build with `npm run build`, set `BRIDGE_NETWORK=preprod` and `BRIDGE_STATE_DIR` to the deployed route, then run `npm run monitor`. It runs the accounting check in a bounded subprocess, serializes checks, persists failure state atomically and serves only loopback:

- `GET http://127.0.0.1:9095/healthz`: HTTP 200 only while a fresh check is settled; otherwise HTTP 503. Stale evidence never remains healthy indefinitely.
- `GET http://127.0.0.1:9095/metrics`: Prometheus gauges for health, consecutive failures and last check/success times. It contains no keys or signed bytes.

Default interval is 60 seconds after each completed check, timeout 45 seconds, alert-state threshold three consecutive failures, and stale limit 180 seconds. A single inconsistent check changes health to degraded immediately; subsequent failures raise the alert state. State transitions are emitted as JSON on stdout. The supplied Prometheus rules include unhealthy, unavailable and stale checks. Wire them to the appointed operator's Alertmanager receiver; this code does not send emails or messages, and no external alert destination has been configured.

`npm run monitor -- --once` performs one check and exits with an appropriate status. `BRIDGE_MONITOR_DIR` holds the durable status file; `BRIDGE_MONITOR_LOCK_DIR` can place the process lock in a separate runtime folder. Run only one monitor per state directory/port. Graceful SIGTERM removes the lock. After an abrupt manual process kill, inspect the lock's PID and verify no monitor remains before removing a stale lock. The supplied systemd service uses a runtime directory that systemd clears between service lifetimes, while durable status remains under `/var/lib/bridge-monitor`.

A healthy sample checks code/configuration pins, immutable Midnight authority, backing versus circulation and unresolved journals. It is not proof that every transfer was delivered, a load test, or an independent audit. Cross-chain samples are not atomic; in-flight deposits and withdrawals can temporarily appear unsettled. Investigate before acting. The monitor never signs, transfers, retries, rebalances, pauses or upgrades a contract automatically.

### Linux installation

Templates are in [`infrastructure/monitor`](../infrastructure/monitor). Build the exact reviewed source under `/opt/midnight-ton-bridge`, create the `bridge` service account and state paths, review/copy the environment and systemd unit, then enable it through the operator's normal service-management process. Verify the Node executable path and use Node 24 (22.18+ minimum). Configure Prometheus to load the supplied scrape and alert rule files.

The route check does not open a wallet or read wallet secrets. It needs public route deployment JSON and read access to the **live** transaction journals and SQLite WAL/SHM files. Do not substitute stale journal snapshots. Restrict seed, committee, mnemonic, wallet-sync and LP-secret paths; the template masks known secret filenames and should be adapted to the deployment's complete key layout. Keep the monitor state directory writable and the bridge source read-only.

## Liquidity and incidents

Use testnet-issued tokens for test liquidity. Lock both assets on TON, claim representations, then add them to the Midnight pool. Escrow backing belongs to token holders; it is not an LP treasury. Keep relayer TON and DUST separate from reserves. Back up the LP secret before submission, quote using current reserves and set slippage minima (see [LP ownership](architecture.md#lp-ownership-and-withdrawals)).

On inconsistency: stop new signatures, preserve logs/snapshots, compare independent chain views, account for every in-flight transfer, and communicate through the appointed operator. On key compromise, stop the remaining signer(s); already issued signatures cannot be revoked. The fixed committee and immutable Midnight contract require a new backed route for rotation. Do not abandon collateral when migrating or shutting down.

The source handover does not imply a hosted watcher, alert subscription, real liquidity contribution or indefinite service. Those require an assigned operator and a written service scope.
