# Release and acceptance

This tracks the bridge/SDK component against the supplied agreement; it does not amend that agreement or certify all POC/node obligations. Private legal interpretation is kept outside this software package. The excluded whistleblower application remains excluded from this implementation.

## Build the private handoff

After committing the reviewed source and passing CI, from a clean checkout:

```sh
npm run build
npm run release -- manifest     # docs/evidence/build-manifest.json (after proving keys exist)
npm run release -- benchmarks   # docs/evidence/benchmarks.json from the testnet evidence
npm run release -- handoff      # output/handoff
```

The manifest records SHA-256 hashes for every tracked file except the published evidence, plus the built TON code and proving keys; regenerate it after changes. `output/handoff` contains the committed source archive, SDK tarball, documentation, public testnet evidence, checksums and a standalone notes starter with its SDK vendored. The handoff manifest records the source commit. Do not distribute an archive from one revision alongside uncommitted implementation changes. Local wallet state, keys and the commercial agreement are excluded. The SDK package includes generated runtime bindings; prover files are rebuilt rather than bundled. `npm run release -- check-package PACK_JSON` rejects private paths (`.state`, `.env` files, seeds, mnemonics, wallet configs, journals, locks and local tools) and missing files in `npm pack --json` output. Deliver privately through the approved Foundation channel.

On macOS, with `say`, `ffmpeg`, Python and Pillow installed (`BRIDGE_PYTHON` selects the interpreter, default `python3`):

```sh
npm run release -- video
```

This creates `output/demo/bridge-testnet-walkthrough.mp4` and `transcript.txt`. It is an AI-narrated review of completed, independently verified testnet evidence, not an attended live screen recording. Review and upload to the authorized Loom account, or use the [acceptance script](#acceptance-demonstration-script) to record an attended demonstration if required. A local video is not a Loom link or acceptance.

## Deliverables and sign-off

Engineering can prepare and verify the implementation and artifacts. The items below require authoritative input or action by the named party; none is marked complete solely because a repository, test or AI-generated report exists. Do not replace them with an internal checklist mark or an AI-generated approval.

| Deliverable | Repository evidence | Owner and acceptance still required |
| --- | --- | --- |
| Bridge specification and cross-chain integration | [Architecture](architecture.md), contracts, SDK, observer/relay scripts | Agree trusted quorum model, approved token masters and testnet demonstration / production release criteria |
| Functional TON–Midnight bridge | TVM/runtime tests, local proof evidence, public testnet evidence ([testing](testing.md)) | Local proofs and public two-chain round trip completed; Foundation demonstration acceptance remains |
| WHIS/USD1 assets and pools | Asset registry schema, reference-wallet adapter, live existing-master validation, two-asset Midnight AMM | Issuers/Foundation provide approved master addresses, code versions, decimals and freeze/upgrade policy, and approve pool count/location and seed amounts. The current demonstration uses valueless testnet tokens |
| Developer SDK | Versioned TypeScript package, generated bindings, config and methods | Third-party integration and release version acceptance |
| Notes scaffold, env.example and independent developer build | `examples/notes`, separately packaged starter, SDK tarball and clean-consumer checks | A separate developer clones the starter and records a successful build on their machine; agree privacy interaction scope |
| Private source and deployment scripts | This checkout and [handoff tooling](#build-the-private-handoff) | Tagged private GitHub delivery and Foundation access; publication terms confirmed |
| Diagrams, API and integration documentation | README, [architecture](architecture.md), [deployment](deployment.md), [operations](operations.md) | Reviewer follows instructions without undocumented assistance |
| Benchmarks and test results | [Testing](testing.md), [`benchmarks.json`](evidence/benchmarks.json) with six total-call timings on named hardware | Agree numerical targets; independently measure isolated proving time and throughput if required |
| Security review | Review findings fixed in source and tests; failure traces; source manifest | A separate qualified reviewer examines exact source/verifier hashes, resolves high-risk items for the chosen environment and signs off with a report |
| Review report publication (IPFS) | None yet; the independent report does not exist | Authorized publishing/pinning operator uploads the approved report and verifies retrieval/pin retention |
| Loom demonstration | Reproducible test and demo commands; local MP4 and transcript, identified as a finalized-evidence walkthrough | Authorized account uploads/reviews the narrated recording or records an attended live demonstration. Code or logs alone are not this artifact |
| Production custody | Key generation, signer policy, route pins and immutable committee design | Three independent operators supply verified public keys, key handling and recovery procedures |
| Node and service operations | [Monitoring](operations.md#monitoring) service/template, [recovery runbook](operations.md#recovery), deployment instructions | Appointed infrastructure owner accepts service duration, uptime, reporting, gas/DUST budget and incident response. Bridge code does not fulfill node uptime/SLA obligations |
| Mainnet release | [Gated mainnet procedure](deployment.md#deploy-to-mainnet--gated-production-handoff); broadcasting remains disabled | Foundation/operator approve reviewed assets and production network configuration |
| Real liquidity | LP API and testnet swap/withdrawal evidence | Named capital provider agrees amounts, ownership, fees and withdrawal terms |
| Findings and production roadmap | [Scope and trust](architecture.md#scope-and-trust), operations, [roadmap](#production-roadmap) | Foundation review |
| Foundation acceptance | Not a software artifact; this checklist and the complete private handoff bundle | Foundation's explicit written component/overall acceptance |

No invented issuer approval, audit signature, custodian identity, Loom URL, IPFS publication or Foundation acceptance is included. No mainnet launch, real liquidity, IPFS upload or Loom publication has been performed by this implementation.

## Acceptance demonstration script

1. State exact source revision, supported versions, network IDs, token masters, contract addresses and trust assumptions. Show no real USD1 or confidential note data.
2. Show token backing move into the TON escrow, the registered receipt and two independently produced attestations.
3. Claim on Midnight; show final transaction status and increased recipient token balance. Attempt replay and wrong-recipient authorization and show rejection.
4. Bridge both configured tokens on testnet, seed the pool, show reserves/quote, execute a bounded swap and withdraw LP liquidity with the private LP authorization kept off screen.
5. Retire tokens on Midnight; show the recorded commitment and two independent reverse attestations. Release on TON and inspect recipient jetton delivery, not merely wallet-request submission.
6. Demonstrate restart/ambiguous-submission reconciliation and explain the exact-sender refunds and authenticated bounce recovery; show an underfunded deposit recovered as a quorum-attested refund (`npm run demo:unrecorded`).
7. A separate developer installs the SDK and notes scaffold using only delivered documentation. Record machine/tool versions, commands and results.
8. Deliver source, checksums, evidence, independent review report, Loom link and production recommendations; obtain written acceptance against the agreed bridge deliverables.

## Production roadmap

No successful local or testnet test substitutes for independent review, operator handover and Foundation acceptance before any real-value use. The prerequisites for a mainnet release (approved assets and adapters, specialist Schnorr and security review, independent custody, infrastructure ownership, a reviewed production network configuration and a capped canary) are the [gated mainnet procedure](deployment.md#deploy-to-mainnet--gated-production-handoff). In addition, before valuable assets:

- Implement committee key rotation/migration and emergency response.
- Validate full message-trace reconciliation, including delayed returns.
- Deploy the supplied monitoring runner and wire its alert receiver.
- Add a hosted signer/relayer service and browser wallet integration if required, with a privacy design and agreed UX.
- Measure load and failure recovery against agreed targets.
- Conduct an external adversarial testnet exercise before a capped launch with explicit asset/liquidity budgets.

No part of this roadmap creates an agreed obligation to fund real liquidity or provide indefinite bridge hosting. The Foundation should explicitly accept software handover and allocate deployment, custody, liquidity and ongoing operations in the scope amendment before relying on that delivery model.
