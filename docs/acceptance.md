# Delivery and acceptance checklist

This tracks the bridge/SDK component against the supplied agreement; it does not amend that agreement or certify all POC/node obligations. Private legal interpretation is kept outside this software package. The excluded whistleblower application remains excluded from this implementation.

| Deliverable | Repository evidence | Acceptance still required |
|---|---|---|
| Bridge specification and cross-chain integration | architecture, contracts, SDK, observer/relay scripts | Agree trusted quorum model, approved token masters and testnet demonstration / production release criteria |
| Functional TON-Midnight bridge | TVM/runtime tests, local proof evidence, public testnet evidence | Local proofs and public two-chain round trip completed; Foundation demonstration acceptance remains |
| WHIS/USD1 pools | configured token masters, reference-wallet adapter and two-asset Midnight AMM | Foundation approves actual WHIS/USD1 masters, decimals, pool count/location and seed amounts; current demonstration uses valueless testnet tokens |
| Developer SDK | versioned TypeScript package, generated bindings, config and methods | Third-party integration and release version acceptance |
| Notes scaffold and env.example | examples/notes | Deliver separately clonable starter; third-party builds it on another machine; agree privacy interaction scope |
| Private source and deployment scripts | this checkout and packaging tools | Tagged private GitHub delivery and Foundation access; publication terms confirmed |
| Hybrid diagrams/API/integration documentation | README, architecture, operations | Reviewer follows instructions without undocumented assistance |
| Benchmarks/test results | validation report and test/proof evidence | Agree numerical targets; record wall-clock proof/confirmation and throughput measurements on named hardware |
| AI-driven security review and passing review | security-review document | Resolve high-risk items for chosen environment; reviewer sign-off; PDF/IPFS and SDK link delivery |
| Bridge Loom demonstration | reproducible test and demo commands | Record narrated video and supply Loom link; code or logs alone are not this artifact |
| Findings and production roadmap | security review, operations, roadmap below | Foundation review |
| Written POC acceptance | not a software artifact | Foundation's explicit written component/overall acceptance |
| Continuous node operations | separate service | Verify separately; bridge code does not fulfill uptime/reporting/SLA obligations |

## Acceptance demonstration script

1. State exact source revision, supported versions, network IDs, token masters, contract addresses and trust assumptions. Show no real USD1 or confidential note data.
2. Show token backing move into the TON escrow, the registered receipt and two independently produced attestations.
3. Claim on Midnight; show final transaction status and increased recipient token balance. Attempt replay and wrong-recipient authorization and show rejection.
4. Bridge both configured tokens on testnet, seed the pool, show reserves/quote, execute a bounded swap and withdraw LP liquidity with the private LP authorization kept off screen.
5. Retire tokens on Midnight; show the recorded commitment and two independent reverse attestations. Release on TON and inspect recipient jetton delivery, not merely wallet-request submission.
6. Demonstrate restart/ambiguous-submission reconciliation and explain the exact-sender refunds and authenticated bounce recovery; explain missing-notification limits.
7. A separate developer installs the SDK and notes scaffold using only delivered documentation. Record machine/tool versions, commands and results.
8. Deliver source, checksums, evidence, review PDF/IPFS reference, Loom link and production recommendations; obtain written acceptance against the agreed bridge deliverables.

## Production roadmap

Before valuable assets: choose audited production jetton adapters and actual USD1 issuer authorization; review Schnorr and all arithmetic/state transitions independently; verify the immutable Midnight authority on the accepted deployment; implement committee key rotation/migration and emergency response; assign secure key custody, independent infrastructure, gas/DUST and monitoring; validate full message-trace reconciliation including delayed returns; add a durable service runner/metrics/alerts, browser wallet integration if required, privacy design and agreed UX; measure load and failure recovery; conduct an external adversarial testnet exercise and capped launch with explicit asset/liquidity budgets.

No part of this roadmap creates an agreed obligation to fund real liquidity or provide indefinite bridge hosting. The Foundation should explicitly accept software handover and allocate deployment, custody, liquidity and ongoing operations in the scope amendment before relying on that delivery model.
