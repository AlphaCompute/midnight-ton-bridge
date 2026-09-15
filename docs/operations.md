# Operator runbook

Use the [README](../README.md) for deployment commands and liquidity. This document describes custody and recovery. The code does not assign or finance ongoing operations.

## State and custody

`BRIDGE_NETWORK=local` uses `.state`; `preprod` uses `.state/preprod`. `BRIDGE_STATE_DIR` overrides the directory deliberately. Never share a directory across identities/networks or run concurrent Midnight wallet processes against it. Secret JSON files must be owner-only (`chmod 600`), directories should be mode 700. Back up journals, seed files, wallet checkpoints and LP secrets securely. Do not copy them into delivery artifacts.

The new Midnight deployment has no usable maintenance authority. Keep its candidate, intent and confirmed record: these identify an interrupted deployment. Old development deployments with different verifiers/authorities remain separate routes. Never replace a deployed verifier file locally and assume the chain changed.

Generate one operator per independent custodian with `npm run operator -- keygen PRIVATE_DIRECTORY`. Distribute only `public.json`. The three centrally held `demo-operators.json` keys are for disposable testnet demonstrations only.

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

Reverse signer configuration contains `network`, `indexer`, `indexerWS`, Midnight `address`, deployment `pins`, two `escrows`, the three TON public-key hex strings in `committee`, `signer`, `keyFile` and the same `policy` object. Run `npm run operator -- attest-redemption CONFIG REQUEST_JSON`. Request fields are `id`, `asset`, decimal `amount`, basechain `recipient` and finalized Midnight `transactionId`. The signer checks successful finality, the state at that block, verifier/authority/domain pins and the exact retirement commitment.

Create each configured stop file to halt new signing. Quota is reserved before signature exposure and identical retries are idempotent. A different digest for the same receipt is refused. Do not erase signing history to bypass a limit or conflict. Already issued signatures remain usable.

## Relay and reconciliation

`npm run relay -- claim BRIDGE_CONFIG A.json B.json` requires two identical canonical receipts and different valid signers. It validates and prints the prepared claim without opening a wallet. Add `--send` to submit to the matching Midnight network and check successful finalization.

`npm run relay -- release TON_CONFIG A.json B.json` prepares a release message; add `--send` with `BRIDGE_NETWORK=preprod` to broadcast. TON_CONFIG contains `network: "ton-testnet"`, `domain`, two `escrows`, three TON `committee` keys and owner-only `walletKeyFile`. Signed bytes are persisted first. Treat submission as pending.

Journal stages are `observed → prepared → sending → submitted → confirmed/rejected`. `sending` can mean a successful broadcast followed by a lost response. For Midnight, run `npm run reconcile -- EXACT_TRANSACTION_ID` against its original state/network. Do not recreate a transaction from the business request. A timeout or unknown result is not rejection.

For the `openTon` journal, run `npm run reconcile:ton -- ID` (or `all`) to locate the exact external wallet message by its saved body hash in an older chain snapshot. This confirms wallet execution only; recipient delivery still requires the jetton trace. For TON, preserve the recorded wallet, sequence, body hash and signed BOC. Find the wallet transaction containing that body, then follow the escrow request and outgoing jetton internal transfer. `verifyJettonDelivery` in `src/ton-finality.ts` compares the source outgoing message to the recipient incoming message and checks both transaction executions at an older snapshot. It examines recent history; archive/older traces require an explicit historical query. `releaseState(id)==1` only records submission to the wallet. Never mark a payout confirmed from an account balance alone.

`openTon().send` serializes sends with `ton-wallet.lock`. A stale lock after a crash must be removed only after verifying that no process owns the wallet and reconciling its journal. A fresh wallet sequence is not permission to duplicate an already executed transfer.

## Refund and failure handling

Malformed or cap-exceeding authenticated deposits create an exact refund record. Query `refundCount` and `refund(id)`, then relay SDK `refundBody(id)` to the escrow with at least 0.15 TON. Anyone can relay it; only the recorded sender is paid. Repeated/nonexistent IDs fail. There is no unrestricted recovery opcode.

An immediate authenticated wallet bounce restores the pending release/refund. The supplied wallet also authenticates recipient bounces and reports downstream failure; the escrow restores only that matching pending amount. Test coverage includes an actual destination failure followed by a successful retry. Production jettons do not necessarily implement this callback.

The fixture wallet rejects transfers without the minimum notification gas. Direct issuer mints into an escrow and unsupported production token paths may still lack a receipt. Do not manufacture a claim or infer recoverable surplus from balance minus `locked`. Preserve the trace and resolve the unsupported transfer through an agreed, independently reviewed asset-specific design. Never deploy a general administrator drain as a convenience repair.

## Liquidity and incidents

Use synthetic minters for test liquidity. Lock both assets on TON, claim representations, then add them to the Midnight pool. Escrow backing belongs to token holders; it is not an LP treasury. Keep relayer TON and DUST separate from reserves. Back up the LP secret before submission, quote using current reserves and set slippage minima.

On inconsistency: stop new signatures, preserve logs/snapshots, compare independent chain views, account for every in-flight transfer, and communicate through the appointed operator. On key compromise, stop the remaining signer(s); already issued signatures cannot be revoked. The fixed committee and immutable Midnight contract require a new backed route for rotation. Do not abandon collateral when migrating or shutting down.

The source handover does not imply a hosted watcher, alert subscription, real liquidity contribution or indefinite service. Those require an assigned operator and a written service scope.

## Current standard-wallet route

Use `deploy:bridge-ton` for the current reference-wallet adapter. `deploy:ton`
remains the historical custom-wallet integration for reproducing earlier evidence.
Existing-master deployments verify master and wallet code/address pins. Use the
[standard recovery procedure](standard-recovery.md) for a downstream rejection;
the old wallet's custom failure callback does not apply to this route.

Run `check:route` after settled operations and after reconciling journals. It
compares backing and circulation and reports unresolved sends. Differences can
represent in-flight deposits/refunds or a real accounting problem; do not repair
them with unverified claims. Archive each route's deployment and transaction
records, including routes still holding collateral.

A new TON send ID cannot bypass an earlier prepared or ambiguous send. Reconcile the stored transaction first. Submitted sends reserve their wallet sequence until the on-chain sequence advances; recipient delivery remains a separate trace check.
