# AI-assisted security review

Reviewed 2026-09-14 by the implementing agent. Scope: TON reference-wallet adapter and legacy integration, Compact bridge and pool, SDK, signers, relay/persistence and deployment workflows. This is not an independent audit. The full bridge is deployed and validated on testnet; mainnet execution is disabled pending production review and configuration.

## Implemented findings

| Finding | Resolution and evidence |
| --- | --- |
| Quorum could redirect arbitrary recovered collateral | Removed unrestricted recovery opcode. Refunds require an authenticated recorded sender/amount and cannot select another payee. TVM tests cover malformed deposits, capacity overflow, replay and unknown refund IDs. |
| Forged fixture-wallet bounce could inflate balance | Outgoing query IDs bind amount and expected recipient wallet. Only matching bounced messages restore funds. Tests inject forged bounce messages. |
| A downstream recipient failure could strand a release | Supplied fixture wallet reports an authenticated failure to its owner; escrow restores the exact pending release/refund. TVM test forces destination overflow, processes the real bounce, restores backing and successfully retries. This callback remains legacy-specific. The new standard adapter verifies a complete three-transaction failure trace off chain and requires 2-of-3 signatures bound to the exact pending cell, query and bounce evidence. Unmodified reference-wallet tests cover a real downstream failure, forged evidence, replay and successful retry. |
| Midnight maintenance key could alter verifier rules | New deployments use an empty authority committee with threshold 1. Deployment reads back this impossible authority. Final local deployment and proof-backed calls have executed successfully. Older development deployments are superseded, not retroactively made immutable. |
| Invalid curve points and signature scalar malleability | Constructor and claims reject identity/non-subgroup points; response decomposition is constrained and bounded below the subgroup order. SDK rejects noncanonical responses. Tests cover torsion, identity, invalid points and response plus subgroup order. `upgradeFromTransient` truncates and is intentionally not used for full scalar range validation. |
| Excess pool deposits could donate value unexpectedly | Subsequent paired deposits require the exact rounded-up reserve ratio. Seeded swap tests check nondecreasing product; tests reject donation, slippage and dishonest quotient witnesses. |
| Operator could sign conflicting payloads without durable policy | SQLite signing ledger binds IDs to digest, reserves daily quota atomically, limits per-transfer amounts and checks a stop file before signing. Keys must match the configured slot. Tests cover retry, quota, equivocation and pause. |
| Cross-network state and stale artifacts | Separate network state directories; conflicting environments rejected; owner-only secret readers; stale Compact fingerprint rejects build/test. Deployment plans cannot silently change a prior route. |
| Ambiguous sends/restarts | Persist signed bytes before broadcast; compare-and-set journal stages; no blind replacement sends. Wallet synchronization is checkpointed. Transaction IDs, wallet sequence changes and recipient delivery are distinct. |
| Missing transfer notification | Fixture wallet now rejects zero/insufficient notification gas. TVM tests verify the sender balance and deposit count stay unchanged. |
| Missing recipient finality validation | Added source/recipient jetton message-hash matching and successful recipient transaction checks at an older masterchain snapshot. Trusted RPC remains a declared assumption. |
| Linux bootstrap did not find compiler | Corrected target directory; GitHub-hosted Linux build/tests/package workflow passed after the fix. |

The current `npm audit` scan reported zero known dependency vulnerabilities. That database result is not evidence that dependencies contain no vulnerabilities.

## Standard-adapter additions

- Vendored the unmodified MIT-licensed TON reference wallet/minter at commit
  `1182ad99413242f09925d50e70ccb7e0e09f94d4`, with pinned FunC compiler dependency.
- Added configured existing-master deployment. Issuing tokens is a separate,
  explicit testnet setup option; the bridge does not need issuer mint keys.
- Standard recovery only reopens existing pending instructions. Signers check
  canonical testnet identity, pinned token/escrow configuration, exact finalized
  transaction locators and all trace-message links before signing.
- Release CLI now uses the common network-pinned, locked, journaled TON sender.
- Added a read-only accounting command checking both token backing, bridge
  circulation, code/configuration pins and unresolved journals. It reports
  differences without automatically moving funds.

## Follow-up review (2026-10-12)

Second AI-assisted pass over the TON escrows, Compact contract, signer, relay, recovery, journal, web app, example server and build pipeline, including the uncommitted unrecorded-credit recovery and wallet-expiry work. Still not an independent audit.

| Finding | Resolution and evidence |
| --- | --- |
| MEDIUM — An oversized (above uint64) deposit was returned with 0.06 TON from the escrow's own balance and the unused TON sent to the depositor, so looping such deposits could siphon the escrow's TON until storage fees froze it with user deposits inside | The return transfer's response destination is now the escrow, so the escrow only bears fees and the depositor gains nothing. `tests/standard-escrow.test.ts` asserts the escrow's TON loss stays below 0.03 TON and the sender's balance does not grow. Requires the same redeploy as the unrecorded-credit opcode. |
| LOW — `bootstrap.sh` verified the Compact archive against a checksum downloaded from the same release, which cannot detect a replaced release | Per-platform SHA-256 values are pinned in the script. |
| LOW — CI used mutable action tags and persisted the checkout token | `actions/checkout` and `actions/setup-node` are pinned to commit SHAs and the checkout does not persist credentials. |
| LOW — The notes starter stored unlimited notes in process memory | Storage is capped (default 1000, configurable through `start`) and returns 507 when full; the example tests cover the limit. |

Reviewed without change: escrow message authentication, quorum ordering and domain separation for release, restore and unrecorded-credit digests; per-credit replay protection; signer quota and equivocation checks; Schnorr subgroup and scalar canonicality; pool rounding direction; journal compare-and-set stages; wallet-expiry reasoning; static-file path handling, CSP, origin and body-size checks in the web app. Noted, not changed: `redactEndpoints` is not yet applied to logged errors, so operators should keep logs that may contain Blockfrost URLs private; a redemption ID can be front-run on Midnight to make the victim's transaction fail (no funds move); the web app has no rate limit on balance lookups and should stay behind a proxy that applies one if exposed beyond localhost.

## Remaining boundaries and production blockers

**HIGH — Committee and RPC trust.** Two compromised/colluding committee members can mint unbacked representations or authorize fraudulent releases. Rate limits reduce exposure but do not remove that authority. The demonstration uses three keys on one development host. Independent custodians, independent trusted infrastructure and explicit trust-model acceptance are required for external use. A light-client bridge is a different implementation.

**HIGH — Specialist cryptographic review.** The custom Jubjub Schnorr transcript uses a 248-bit challenge and explicit subgroup/scalar constraints. Tests and real proofs exercise correctness for selected inputs; they do not establish Fiat–Shamir security or complete circuit soundness. Obtain independent cryptographic review before valuable assets.

**HIGH — Production asset approval is outstanding.** The standard adapter now supports the original reference wallet layout without custom storage or callbacks. Existing-master deployment validates pinned code, master-derived wallet addresses, owner/master relationships and configured caps. This is not issuer approval for WHIS or USD1, nor universal compatibility with every TEP-74 wallet. Actual production masters, code versions, freeze/upgrade controls and decimals must be agreed and reviewed. Mainnet remains disabled.

**MEDIUM — Missing notifications and storage/liveness.** The SDK supplies notification gas. The legacy wallet rejects insufficient forwarding; an external standard wallet cannot be forced to do so by this bridge. Underfunded or missing notifications from sender wallets are refundable through quorum-attested credit evidence (below). Direct issuer minting into an escrow still creates inventory outside the ledger. No arbitrary surplus-drain path is provided. Receipt, release and pending-history maps retain records and grow with usage. Cap amounts, provide gas/storage reserves and measure sustainable load. Fixed committee replacement requires an accounted new-route migration.

**Resolved in code, pending redeploy — underfunded deposit notifications.** Measured in `tests/standard-escrow.test.ts`: the standard escrow needs roughly 7–11k gas to record a deposit or refund. A transfer forwarding 1 nanoton skips the escrow's compute phase, one forwarding about 0.0001–0.0005 TON runs out of gas, and a zero forward sends no notification. Previously these credits had no record and no recovery. The standard escrow now accepts opcode `0x42524705`: 2-of-3 committee signatures over an exact finalized credit transaction record an ordinary refund to the original sender, once per credit (`recovered(evidence)`). Signers verify that the sender's own reference wallet made the credit and that the escrow never processed the notification (`observeUnrecordedCredit`). This adds no committee power beyond release. Deposits above the uint64 ledger are now returned to the sender at once instead of throwing; the escrow funds that return and receives its unused TON back, so the sender cannot profit by looping oversized deposits. Non-basechain senders cannot hold reference jettons. The current public testnet escrows run the previous code (`69a765…`) and need a new route deployment to gain this; the Midnight contract is unchanged. Issuer mints sent directly to an escrow remain outside the ledger.

**MEDIUM — Operations and acceptance.** A durable read-only monitoring runner, health/metrics endpoints and Prometheus alert templates are supplied and tested. They do not constitute a hosted signer service, configured external paging receiver, SLA or an appointed operator. The monitor does not read wallet keys or perform corrective transactions. Gas/DUST, independent custody, disaster recovery and operating duration must be assigned. Stop files prevent new signatures but cannot cancel existing signatures. User funds and pending journals must remain accounted for during shutdown.

**MEDIUM — Privacy/economics.** Bridge transfers and balances are unshielded/linkable. The notes starter is local-memory software with a salted commitment, not an on-chain private-note protocol. First LP sets the unit ratio; integer rounding and price movement affect returns. No dollar peg, anonymity or principal guarantee is supplied. Decimals, test liquidity amounts and any further privacy deliverables require scope acceptance.

**LOW — Independent reproduction and delivery artifacts.** Hosted CI and local clean installs are useful but are not the agreement's independent developer acceptance. Obtain the separately performed build, demonstration recording, approved PDF/IPFS reference and written Foundation acceptance.

## Validation interpretation

See [validation](validation.md) and the source/artifact hashes in [build manifest](build-manifest.json). TVM tests exercise contract execution; local Midnight evidence exercises actual proofs and ledger finalization. Public two-chain completion must be supported by its own `testnet-evidence.json` with final recipient delivery. A script, submitted transaction or faucet acknowledgment alone is insufficient.

## Primary references

- [TON contract security](https://docs.ton.org/v3/guidelines/smart-contracts/security/common-vulnerabilities/): authenticate messages and account for asynchronous effects.
- [Jetton lifecycle](https://docs.ton.org/contracts/standard/tokens/jettons/how-it-works) and [transfer flow](https://docs.ton.org/contracts/standard/tokens/jettons/transfer): wallet forwarding, notification and failure behavior.
- [Midnight Schnorr example](https://github.com/midnightntwrk/example-zkloan/blob/main/blog-post.md): transcript implementation reference, not an audit certificate for this code.
- [Midnight wallet synchronization work](https://github.com/midnightntwrk/midnight-wallet/issues/288): event replay and alternative Merkle-tree synchronization; live network/toolchain compatibility must be verified.

Release decision: deliver the full bridge implementation and its testnet deployment with these limitations and actual evidence. Do not label it audited, production-ready, privately anonymous or contractually accepted.
