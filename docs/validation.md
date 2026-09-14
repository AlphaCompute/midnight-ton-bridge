# Validation record

Date: 2026-09-14. Scope: synthetic test assets; no mainnet deployment or real LP capital. This record separates local verification, public testnet evidence and external acceptance.

## Completed engineering checks

| Check | Result |
| --- | --- |
| TypeScript/build | Passed with strict types and stale-Compact-artifact guard |
| Automated suite | 12 tests passed, zero failed; includes seeded pool trials and multiple adversarial cases per test |
| TON | All three Tolk contracts compile; TVM lock/claim/retire/release, exact refunds, replay, forged notification/bounce, low notification gas, downstream failure and successful retry pass |
| Cryptography/arithmetic | Identity/torsion/noncanonical scalar, changed domain/contract/asset/amount/recipient, quorum, cap, replay, dishonest quotient, LP authentication, slippage and donation rejection pass |
| Operator/persistence | Quota, equivocation, idempotent retry, stop switch, secret permissions, network isolation, pinned TON genesis and durable ambiguous-send tests pass |
| Recipient trace | Source/recipient message-hash match checked against actual Sandbox transactions; wrong source/amount rejected |
| Local proofs | New immutable deployment plus two claims, addLiquidity, swap, removeLiquidity and redeem finalized successfully |
| Local readback | All six calls independently re-read; pool reserves/shares zero, circulation 9,900/10,000, one retirement; altered reverse-observer pins/request rejected |
| Wallet restart | Checkpoint serialized, reopened with the same identity, synchronized and closed; lock lifecycle passed |
| SDK delivery | Packed SDK installed into a fresh directory outside the checkout; copied notes starter test passed |
| Notes starter | Its separate test passed |
| Linux CI | GitHub-hosted bootstrap/build/tests/starter/package workflow passed after correcting compiler target path; final release SHA must also be green |
| Dependencies | `npm audit` reported zero known vulnerabilities; this is not a source audit |
| Review PDF | Rendered and visually checked; implementing-agent review, not independent certification |

Machine: macOS ARM64, Node 24.15.0, npm 11. Compact 0.31.1 / runtime 0.16.0 / onchain-runtime-v3 3.0.0 / Midnight JS 4.1.1 / ledger 8.1.0 / Tolk 1.4.2 / Sandbox 0.44.0. Exact transitive versions are frozen by the lockfile. Local images: node 1.0.0, indexer 4.3.3, proof server 8.1.0.

## Local evidence

`docs/local-proof-evidence.json` records the final local address, verifier/authority pins, six transaction IDs, heights/hashes and final state. The immutable deployment is `11e607340d6be9f8780420b69f2b2d43a4b42abc0ac32f48156b83b9bd99f9ce`. Earlier local experiments are superseded. Their state remains preserved for accounting.

Reproduce with the README's local commands and a fresh state directory. `npm run validate:local` checks exact outcomes; it does not merely check that services are healthy. The local claims are synthetic; TON Sandbox is a separate execution layer.

## Public testnet evidence

TON testnet deployment and Midnight preprod deployment have been verified. The accepted route uses domain `742ebc224a2a78fba858a1044df7eb2c31350b1afdad3769d8292d270e70da52` and Midnight address `8349a4b927988e0cf9a7ed0a1fd644c38bcb4a1bea587ba66f5273b7c04eaba0`. Exact TON masters/escrows are recorded in the public deployment evidence. Earlier empty TON fixtures were superseded after the minimum-notification-gas fix; they are not the accepted route.

The complete two-chain round trip passed on the deployed fixtures and was independently reread. `docs/testnet-evidence.json` contains all six circuit finalizations, both TON deposit receipts, the matching source/recipient message hash and a successful recipient credit. Final collateral and Midnight circulation are 9,900/10,000 units, with pool reserves and shares zero. The five TON wallet sends were also reconciled by exact external-message body hash; the separate recipient trace confirms final delivery. `docs/testnet-deployment.json` records code/config/verifier/authority pins and the exact accepted route.

Funding came from test faucets. Initial Midnight full replay was too slow; the new, unused private-asset wallet was initialized with collapsed Merkle updates only after all three roots matched a canonical block and the separate node returned that block's hash. No DUST generations existed. Existing wallets must use normal recovery rather than this new-wallet initialization. The resulting checkpoint synchronized normally and DUST registration finalized.

A WebSocket watcher failure and an HTTP metadata initialization failure exposed a submission issue. The exact saved DUST registration bytes were recovered, accepted and finalized. The provider now uses an isolated node connection for broadcast, journals DUST registration as well as application calls, and obtains finality from the indexer. Unresolved attempts block new submissions.

## Benchmarks and limits

Observed public proof-plus-confirmation timings for this single run:

| Circuit | Seconds |
| --- | --- |
| claim | 39.735 |
| claim | 30.635 |
| addLiquidity | 27.016 |
| swap | 20.35 |
| removeLiquidity | 27.927 |
| redeem | 21.088 |

Individual local timings remain in execution logs; the public JSON records milliseconds. These measurements include network/proof-service latency and are not a throughput guarantee, percentile estimate or SLA. Initial wallet synchronization is a separate cost. Agree target hardware, load, accepted percentiles and failure scenarios before calling the benchmark requirement accepted.

The clean package check was performed by the implementing agent. Hosted Linux CI adds a second environment but does not substitute for the agreement's separately performed developer acceptance.

## Release artifacts and outstanding acceptance

`npm run manifest` records SHA-256 hashes for source, tests, configuration, TON code and proof keys. Regenerate it after changes. The SDK package includes generated runtime bindings; prover files are rebuilt rather than bundled. Package checks exclude private agreement analysis, `.state`, `.env`, secrets and local tools.

Still external: Foundation agreement on test scope/trust model/assets/pools; independent developer reproduction; specialist/independent security sign-off; agreed benchmark thresholds; narrated Loom recording; approved PDF/IPFS reference; private delivery/access and written Foundation acceptance. Continuous node operations and their SLA require separate evidence. No mainnet launch, real liquidity, IPFS upload or Loom publication has been performed by this implementation.
