# Validation record

Date: 2026-10-12. Scope: the full bridge on TON testnet and Midnight preprod; no mainnet deployment or real LP capital. This record separates automated checks, local proof evidence, public testnet evidence and external acceptance.

## Automated checks

`npm run check` builds with strict types (including unused-code checks), rejects stale Compact bindings and runs the suite.

| Area | Coverage |
| --- | --- |
| TON escrow (reference wallet) | Deposits in both payload forms; exact-sender refunds for malformed, over-cap and over-capacity deposits; `excesses` and unknown operations; release guards (TON value, locked balance, quorum, wrong slot, redirected recipient, masterchain); downstream-rejected refunds and releases restored by quorum and paid on retry; unrecorded credits (1-nanoton, out-of-gas and zero-forward notifications) refunded once by quorum from exact traces; deposits above the uint64 ledger returned at once |
| End to end in process | SDK deposit → `observeTon` receipt → `BridgeClient.claim` on the compiled Midnight contract → redemption → release digest from the recorded commitment → TVM release → `verifyJettonDelivery`, with backing equal to circulation |
| Midnight contract | Quorum, signature, domain/contract/asset/amount/recipient binding, replay, cap, canonical scalars, subgroup checks, pool slippage, donation rejection, dishonest quotient witnesses, LP authentication, private redemption nonces |
| Signers | `verifyRedemption` against real verifier keys (runs when `build/midnight/keys` exists): pinned verifiers, domain and maintenance authority before any retirement is used |
| Operations | Journal compare-and-set, ambiguous sends, provably expired TON messages, retry only after proven rejection, multi-endpoint relay configuration, signer quotas, stop file, secret permissions, network isolation, Blockfrost endpoint resolution and token redaction, monitor persistence |
| Web app and notes starter | Their own suites; the starter runs separately with `npm --prefix examples/notes test` |

## Local proof evidence

`docs/local-proof-evidence.json`: an immutable local deployment (`2043d23f…`) with two claims, addLiquidity, swap, removeLiquidity and redeem, all finalized with real proofs and independently re-read by `npm run validate:local`. The final circulation is 9,900/10,000 with an empty pool and one retirement. Altered amounts, maintenance authority and verifier pins are rejected.

## Public testnet evidence

The current route (domain `784780e3…`, Midnight `e666f576…`) runs the escrow code `97f574cf…` with the unrecorded-credit recovery operation, and the Midnight contract with private redemption nonces. `standard-testnet-deployment.json` records every address and code, configuration, verifier and authority pin.

- **Round trip** (`standard-testnet-evidence.json`): two test tokens issued with the unmodified reference minter; both locked on TON, observed and claimed on Midnight; liquidity added, a bounded swap and a full withdrawal; 100 units retired and released on TON, with the recipient credit matched to the escrow wallet's outgoing message. `verify:testnet` re-read all six calls and both chains independently.
- **Stuck-deposit recovery** (`standard-testnet-recovery-evidence.json`): a deposit forwarding 1 nanoton was credited to the escrow wallet while the escrow's compute phase was skipped. Two committee members attested the exact credit, the escrow recorded a refund, and the refund was delivered to the original sender. The escrow's balance and `locked` were unchanged afterwards.
- **Accounting** (`standard-testnet-accounting.json`): `check:route` reports, for both assets, equal TON jetton balance, escrow `locked` and Midnight circulation (9,900 and 10,000), all journals resolved, and escrow caps within the Midnight cap. The monitor reported the route healthy.
- **Resilience exercised live:** one TON RPC stopped relaying sends. Two signed messages expired unincluded; `reconcile:ton` proved them dead from the unconsumed wallet sequence, `demo:testnet -- --resume` continued without repeating any executed step, and the resend was relayed through a second endpoint.

Routes deployed earlier (escrow code `69a765…` and the first route with this escrow code but the previous redemption circuit) are preserved in their state archives. They are not used for new deposits.

## Benchmarks

`benchmarks.json` records the six public calls (proof generation plus confirmation, single run, macOS ARM64): claim 35.4 s and 50.8 s, addLiquidity 30.2 s, swap 31.3 s, removeLiquidity 30.8 s, redeem 29.4 s. These include network and proof-service latency; they are not a throughput figure or an SLA.

## Environment

Node 24, Compact 0.31.1, compact-runtime 0.16.0, ledger 8.1.0, Midnight JS 4.1.1, Tolk 1.4.2, TON Sandbox 0.44.0; local images node 1.0.0, indexer 4.3.3, proof server 8.1.0. Midnight preprod is reached through Blockfrost, because Midnight retired its hosted preprod endpoints on 9 October 2026. The lockfile freezes all transitive versions; `docs/build-manifest.json` records source, contract and key hashes.

## Outstanding acceptance

Independent developer reproduction, specialist cryptographic and security review, agreed benchmark thresholds, the recorded walkthrough and written acceptance remain external. Mainnet remains disabled. See [acceptance](acceptance.md).
