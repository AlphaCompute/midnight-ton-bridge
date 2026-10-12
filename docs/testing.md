# Testing and evidence

Scope: the bridge implementation on local networks and public testnet (TON testnet + Midnight preprod). There is no mainnet deployment or real LP capital. This document separates automated tests, local proof evidence and public testnet evidence; external acceptance is tracked in [release](release.md#deliverables-and-sign-off).

## Automated suite

```sh
npm run check                                            # build (strict types, stale-Compact-artifact guard) and all tests
npm --prefix examples/notes ci && npm --prefix examples/notes test   # notes starter
```

`npm test` runs every `tests/*.test.ts` without proving keys. CI (`.github/workflows/ci.yml`) runs bootstrap, `npm run check`, the notes starter test and `npm run release -- check-package` on hosted Linux. A green CI run is required for the release commit; it is not the separately performed developer acceptance.

| Area | Covered |
| --- | --- |
| TON contracts | The reference-wallet adapter against the unmodified upstream FunC wallet and minter: deposits, release, exact-sender refunds, capacity and oversize returns, payload forms, `excesses`, unknown operations, invalid asset pins, actual recipient rejection with the complete source/rejection/bounce trace, wrong amount/query, forged evidence, restoration replay, successful retry and unrecorded-credit refunds. The legacy fixture-wallet escrow keeps its own sandbox test. |
| Cross-chain | TVM plus the compiled Midnight runtime: lock, claim, retire, release and adversarial rejection; an SDK-driven standard-route end-to-end test through observed receipt, claim, redemption, release and delivery. |
| Cryptography/arithmetic | Identity, torsion and noncanonical Schnorr scalars; changed domain, contract, asset, amount or recipient; quorum, cap and replay; dishonest division witnesses; LP authentication, slippage and donation rejection; seeded pool trials. |
| Retirement | Hashed retirement IDs resist replay and front-running; reverse signers pin verifier keys, maintenance authority and domain. |
| Operator/persistence | Signer quota, equivocation, idempotent retry, stop switch, secret permissions, network isolation, pinned TON genesis, Blockfrost token redaction, durable ambiguous-send reconciliation, reserved wallet sequences, provable-expiry rejection, lock release on journal failure, relay preparation without wallet or network access. |
| Monitor | Failure state across restart, stale evidence, unresolved sends and recovery to healthy only on settled checks. |
| SDK and app | Route validation and circuit digests; web app input, cross-origin, size and upstream-concurrency guards. The packed SDK is checked by `release -- check-package`. |

## Local proof evidence

[`docs/evidence/local-proof.json`](evidence/local-proof.json) records the final local deployment address, verifier/authority pins, the six transaction IDs (two claims, addLiquidity, swap, removeLiquidity and redeem), heights/hashes, final state and the reverse-verification result. Earlier local experiments are superseded; their state remains preserved for accounting.

Reproduce with the [local deployment commands](deployment.md#deploy-to-local-test-networks) and a fresh state directory. `npm run verify:local` re-reads every call and checks exact outcomes, including that altered reverse-observer pins and requests are rejected. Local claims are synthetic; TON Sandbox is a separate execution layer.

## Public testnet evidence

> **Source versus deployed code.** The contract sources were simplified after this route
> was deployed. That changes the TON escrow code hash and the Midnight verifier keys, so
> the current source no longer reproduces the deployed bytecode. The git tag
> `deployed-testnet` marks the source that does: it reproduces escrow code `97f574cf…` and
> all five Midnight verifier pins. Run `verify:ton`, `check:route` and signers for this
> route from that tag. A route deployed from current source gets new pins.

The current route (domain `784780e3…`, Midnight `e666f576…`) runs escrow code `97f574cf…`, with the unrecorded-credit recovery operation, and the Midnight contract with private redemption nonces. It completed the full two-chain round trip and was independently re-read:

- [`testnet-deployment.json`](evidence/testnet-deployment.json): route domain, Midnight address, verifier/authority pins, TON masters, escrows and code/configuration hashes, and the custody label.
- [`testnet-transactions.json`](evidence/testnet-transactions.json): every step of the demonstration, including all six finalized Midnight calls, the two observed TON deposits, the source/recipient message-hash match for the release and final recipient delivery. TON wallet sends were reconciled by exact external-message body hash. `independentReadback` records the re-read pins, immutability, all six calls finalized and collateral matching circulation; `final` records circulation and pool reserves/shares.
- [`testnet-accounting.json`](evidence/testnet-accounting.json): a `check:route` snapshot of backing, `locked` and circulation per asset. Equality is necessary but is not proof of every transfer or an audit.
- [`testnet-recovery.json`](evidence/testnet-recovery.json): a live [unrecorded credit](operations.md#unrecorded-credits-opcode-0x42524705) produced by `npm run demo:unrecorded`. An underfunded deposit credited the escrow wallet without a record, two committee attestations turned that exact credit into a refund, and the refund's recipient delivery was verified by message hash with `locked` and the escrow balance equal afterwards.
- [`testnet-assets.json`](evidence/testnet-assets.json): the route's asset registry, usable as a sample `BRIDGE_ASSETS_FILE`. These are valueless testnet tokens, not WHIS or USD1.

**Resilience exercised live.** One TON RPC stopped relaying sends, and two signed messages expired without being included. `reconcile:ton` proved them dead from the unconsumed wallet sequence. `demo:testnet -- --resume` then continued without repeating any executed step, and the resend was relayed through a second endpoint (`TON_BROADCAST_URLS`).

Routes deployed earlier on the reference adapter are preserved in their state archives and are not used for new deposits. These are escrow code `69a765…`, and a first route with the current escrow code but the previous redemption circuit.

The existing-master planning path was separately run against the public masters, without issuance or broadcast. The monitor was run against the deployed route: `/healthz` returned healthy and Prometheus reported zero consecutive failures; graceful stop and restart retained durable state. Funding came from test faucets. The demonstration committee is held on one host, as recorded in the evidence; it is not independent custody.

The earlier legacy fixture-wallet route also completed a round trip; it is historical and no longer deployable from this repository. Its records are in [`docs/evidence/legacy/`](evidence/legacy/) (see [architecture](architecture.md#legacy-fixture-wallet-route)).

### Incident notes

These explain current safeguards:

- **DUST registration.** A WebSocket watcher failure and an HTTP metadata initialization failure exposed a submission issue during the first preprod wallet setup. The exact saved DUST registration bytes were recovered, accepted and finalized. The provider now uses an isolated node connection for broadcast, journals DUST registration as well as application calls, and obtains finality from the indexer. Unresolved attempts block new submissions. The same setup introduced the verified fast initialization for new, unused wallets described in [deployment](deployment.md#deploy-to-public-testnet).
- **Relayer fixes, 2026-09-15.** Review identified and fixed two relayer behaviors: new TON send IDs can no longer bypass an ambiguous wallet send, and Midnight claim relay defaults to preparation unless `--send` is supplied. The wallet lock also releases if journal initialization fails. Regression tests cover these cases, reserved sequences, malformed journal records and preparation without a wallet or reachable endpoint.

## Benchmarks

[`docs/evidence/benchmarks.json`](evidence/benchmarks.json) records the six total-call durations from the public round trip, the machine they ran on, a summary and explicit limits. It is regenerated from the transaction evidence with `npm run release -- benchmarks`. These durations include transaction preparation, proof, broadcast and finality; isolated proving time and throughput have not been measured. They are not a throughput guarantee, percentile estimate or SLA. Initial wallet synchronization is a separate cost. Target hardware, load, accepted percentiles and failure scenarios must be agreed before the benchmark requirement is accepted.

## Toolchain

The Compact compiler version is pinned in [`scripts/toolchain.env`](../scripts/toolchain.env); exact npm dependency versions (Compact runtime, ledger, Midnight JS, Tolk, Sandbox) are frozen by `package-lock.json`. Local container images are pinned in `compose.yaml`. Use Node 24 (22.18+ minimum). `npm audit` reports known dependency advisories only; it is not a source audit.
