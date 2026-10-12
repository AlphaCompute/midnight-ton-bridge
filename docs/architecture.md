# Bridge architecture

```mermaid
flowchart LR
  User[User TON jetton wallet] -->|Transfer and recipient| Escrow[TON escrow wallet and receipt ledger]
  Escrow -->|Independent snapshots| Signers[Three committee observers]
  Signers -->|Two claim signatures| Midnight[Midnight bridge]
  Midnight -->|Mint representation| Wallet[User Midnight wallet]
  Wallet <-->|Deposit, swap, withdraw| Pool[Two-asset pool]
  Wallet -->|Retire representation| Midnight
  Midnight -->|Finalized retirement commitment| Signers
  Signers -->|Two release signatures| Escrow
  Escrow -->|Authenticated jetton transfer| User
  Immutable[Empty maintenance committee, threshold 1] --- Midnight
```

The CLI relayer transports signed authorizations; it cannot independently mint or release. Signers trust their chain RPC/indexer observations. The new Midnight deployment has no usable maintenance authority. Pool reserves and permanently retired tokens are separately accounted within the Midnight contract.

## Scope and trust

This is a new test-asset POC, not a fork of an existing audited bridge. It implements TON escrow → Midnight wrapped representation → permanent retirement → TON release. Each route bridges two configured assets. The intended production assets are WHIS and USD1; the deployed testnet route uses two valueless test tokens. No official USD1 issuance, peg or issuer integration is implied.

One TON escrow per token authenticates its jetton wallet by deriving the address from the configured master, wallet code and escrow owner. The current adapter, `contracts/ton/escrow-standard.tolk`, derives the unmodified TEP-74 reference wallet layout (balance, owner, master, wallet code); the upstream sources are in `contracts/ton/reference`. It must not be pointed at a token with a different wallet implementation without a reviewed adapter and tests (see [token masters](deployment.md#configure-token-masters)). A fixed three-member committee signs with Ed25519 on TON and Jubjub Schnorr on Midnight; two distinct members are required. The keys and route domain are fixed at deployment. Changing the committee requires a coordinated new deployment and reserve migration; the Midnight deployment itself is immutable (see [operations](operations.md#state-and-custody)).

TON receipts come from the escrow's sequential deposit ledger, not arbitrary jetton notifications observed off chain. Observers read the finalized masterchain snapshot through a trusted RPC, pin the escrow's code and configuration hashes and validate asset, amount and recipient. Each committee member must operate its own observer. RPC output is not a light-client proof. A quorum can collude to mint or withdraw; the implementation does not claim to remove that trust.

Midnight claim signatures bind the route domain, Midnight contract address, source receipt ID, asset, amount and recipient. Receipts are consumed once. Source receipt IDs incorporate TON-testnet, escrow and deposit sequence. Signatures do not expire because the source deposit remains locked until its backed token is retired. No timeout-based refund is allowed while a claim remains possible.

The representation uses Midnight unshielded token primitives. Balances, amounts, bridge correlation and recipients are public. Compact proofs prove correct execution and authorization; they do not make public TON payments anonymous. The LP withdrawal secret remains a private witness. Schnorr uses Compact's transientHash with a 248-bit little-endian challenge from upgradeFromTransient, and the prime-order Jubjub group. This fits the stable Compact compiler's scalar API (version pinned in `scripts/toolchain.env`). This transcript requires independent cryptographic review before valuable assets.

## Retirement and pools

Midnight redemption receives actual tokens, reduces circulating supply and records a commitment to the TON recipient and amount. `redeem(nonce, asset, amount, tonRecipient)` keys the retirement by `redemptionId(nonce)`, a hash of a private random nonce, so an observer of a pending redemption cannot retire its ID first and make it fail. That ID is the TON release receipt. Retired tokens stay permanently locked in the contract. There is no circuit to recover or spend them. AMM sends are bounded by distinct tracked pool reserves, so retired backing cannot become LP inventory. This is retirement by locking, not a claim that the protocol's total minted supply decreases.

The integrated pool supports constant-product swaps between the two configured assets, a 30-bps fee retained in the pool, LP deposits and withdrawals. LP shares are contract records keyed by a hash of an LP secret, not a transferable LP token. Minimum output/share checks protect callers; callers must calculate their acceptable limits. Division uses a witness with lower/upper quotient constraints; the witness is not trusted. Intermediate widths are explicitly bounded.

### LP ownership and withdrawals

Generate a random 32-byte secret and compute `persistentHash(new CompactTypeBytes(32), secret)`. Back up the secret privately. Call `addLiquidity(ownerHash, x, y, minShares)`. The first LP chooses the price ratio and receives shares equal to `x` (asset-0 units). Subsequent `y` must equal `ceil(x * reserve1 / reserve0)`; imbalanced deposits and donations are rejected. Shares are rounded down. Use meaningful slippage minima. Call `removeLiquidity(secret, shares, minX, minY, recipient)` to withdraw. The contract cannot recover a lost secret.

## Asynchronous TON releases

An authorized release debits locked inventory and requests a jetton transfer. State `1` means submitted, not recipient delivery. An authenticated immediate bounce from the escrow's own wallet restores backing and replay eligibility automatically. The reference wallet does not report later downstream failures to the escrow: a downstream rejection is restored only after two committee members attest the complete source/rejection/bounce trace (opcode `0x42524704`), and the restoration applies to exactly the existing pending instruction. Source/recipient message matching is required before final delivery is recorded. See [recovery](operations.md#recovery).

Malformed/cap-exceeding notified deposits receive exact sender/amount refund records. There is no arbitrary committee recovery operation. A sender-wallet credit whose notification was missing or underfunded becomes an exact refund to that sender after 2-of-3 committee attestation of the finalized credit transaction (opcode `0x42524705`, once per credit). Deposits too large for the uint64 ledger are returned immediately. Direct issuer minting into an escrow remains unsupported inventory.

## Persistence and operations

The SQLite WAL journal keeps immutable receipt payloads, prepared transaction bytes and IDs. Compare-and-set transitions prevent concurrent workers claiming the same job. A crash after entering `sending` requires exact-transaction reconciliation. Unknown submission status is not retried with a newly built transaction. Source observations may be re-read safely using the same receipt identity. Destination adapters must return finalized outcomes based on transaction evidence, never health checks. Procedures are in the [operator runbook](operations.md#relay-and-reconciliation).

## Primary research

- [TON Tolk contracts](https://docs.ton.org/contracts/overview): language/tooling. The implementation uses the official Tolk WASM compiler and Sandbox directly for programmatic reproducibility.
- [TON jetton processing](https://docs.ton.org/applications/payments/jettons): authenticate master/wallet and account for message lifecycle.
- [TON Sandbox](https://docs.ton.org/contracts/blueprint/testing/overview): local TVM emulation is separate from public-network acceptance.
- [Midnight unshielded tokens](https://docs.midnight.network/tokens/unshielded-token): token primitives and compatible stable toolchain.
- [Compact language](https://docs.midnight.network/compact/reference/compact-reference): witness disclosure and integer/cast behavior.
- [Compact source](https://github.com/LFDT-Minokawa/compact): compiler and cryptography API cross-checks. Documentation describing newer Secp256k1 helpers did not match the stable compiler; those helpers are not used.
- [Midnight local network](https://github.com/midnightntwrk/midnight-local-dev): isolated local network service configuration. The local indexer example configuration is derived from this project.
