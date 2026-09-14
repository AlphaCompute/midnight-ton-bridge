# Midnight–TON bridge — engineering handoff

This repository supplies a **2-of-3 committee bridge for synthetic test assets**, two TON escrows, a Midnight representation/retirement contract, a WHIS/test-USD1 pool, a TypeScript SDK, signer and relayer commands, and a notes starter. It is Apache-2.0 licensed. The GitHub repository is private; changing its visibility is a separate release decision.

**Verified on 2026-09-14:** the complete TON-testnet/Midnight-preprod lock, claim, pool, retirement and return flow passed. See [public evidence](docs/testnet-evidence.json) and [deployment addresses](docs/testnet-deployment.json).

**Release boundary:** the fixtures are not official WHIS or USD1. Mainnet execution is deliberately disabled. See [validation](docs/validation.md) for actual evidence and [security review](docs/security-review.md) for remaining trust assumptions. Passing tests does not establish an independent audit or Foundation acceptance.

## What is delivered

| Component | Behavior |
| --- | --- |
| TON contracts | Authenticated deposit receipts; quorum release; replay protection; exact-sender refunds for malformed/cap-exceeding deposits; authenticated immediate and downstream failure recovery for the supplied wallet |
| Midnight contract | Quorum mint authorization, permanent retirement of representations, circulating caps, separate pool reserves, swaps and secret-authorized LP withdrawals |
| SDK | Deposit payloads, claim validation, redemption, swap quotes, liquidity calls and a Node provider |
| Operator tools | Independent chain observation, verifier/config pins, durable signing quotas, equivocation rejection and a stop file |
| Persistence | Exact transaction bytes before broadcast, ambiguous-send reconciliation, network-specific secret state and wallet sync checkpoints |
| Verification | Compiled Compact tests, TON TVM tests, adversarial inputs, real local proof transactions, public testnet deployment tools and Linux CI |

This is a code handover. A live service additionally needs an assigned operator, independent key custody, funded gas/DUST, monitoring and incident response. Real LP capital and indefinite bridge hosting are not silently included. The private agreement analysis and proposed clarification remain in the local ignored `output/` folder and are excluded from software distribution. Obtain written acceptance of the agreed test-asset scope; separate federated-node duties remain separate. The whistleblower Telegram application is excluded.

## Build from a clean checkout

Use Node 24, npm, bash, curl, tar and shasum. Docker is needed for local chain/proof services. Supported bootstrap hosts: Linux x86-64/ARM64 and macOS Intel/ARM64. The lockfile pins the complete dependency graph. Compact 0.31.1, runtime 0.16.0, ledger 8.1.0 and onchain-runtime-v3 3.0.0 must remain compatible; do not independently upgrade a WASM runtime.

```sh
git clone git@github.com:AlphaCompute/midnight-ton-bridge.git
cd midnight-ton-bridge
bash scripts/bootstrap.sh
npm run check
npm --prefix examples/notes ci
npm --prefix examples/notes test
npm run compile:midnight -- --proof
npm run manifest
```

Proof-key generation takes several minutes and substantial memory. All five `.prover` and `.verifier` files under `build/midnight/keys/` must be nonempty. Build/test reject stale Compact bindings. Do not modify Compact source while generating keys: recompilation replaces its artifacts. Review `docs/build-manifest.json` after every release build.

## Deploy to local test networks

```sh
docker compose up -d
export BRIDGE_NETWORK=local
export BRIDGE_STATE_DIR="$PWD/.state/local-demo"
npm run deploy:midnight
npm run demo:local
npm run validate:local
```

Compose binds only loopback ports 19944 (node), 18088 (indexer), 16300 (proof server). On older Docker Desktop API negotiations, prepend `DOCKER_API_VERSION=1.44`. Wait for the node/indexer to be ready. Preserve containers if you need their chain history: `docker compose stop`. Recreating the development node may create a fresh chain, invalidating old deployment records.

Local claims are deliberately synthetic. TON execution is covered separately by the combined TVM/Compact test. The local seed is public development infrastructure and must never be used on another network.

## Deploy to public testnet

Public testnet means **TON testnet + Midnight preprod**. Start only the proof server when using public Midnight endpoints. Avoid a local `.env` overriding public URLs: the default `.env.example` intentionally leaves endpoint overrides commented out.

```sh
export BRIDGE_NETWORK=preprod
unset MIDNIGHT_NETWORK BRIDGE_STATE_DIR
npm run prepare:testnet
docker compose up -d proof-server
npm run compile:midnight -- --proof
npm run compile:ton
```

For a newly generated wallet that has never received shielded assets or generated DUST, an optional fast initialization verifies all three collapsed Merkle roots against a canonical block and checks that there are no DUST generations. Run it only once, immediately after preparation:

```sh
npm run wallet:sync -- --initialize-only
npm run bootstrap:wallet -- --new-unused-wallet
```

The helper checks local usage history, active locks, on-chain DUST generations and a recent fresh-wallet marker. Those checks do not replace the requirement that the wallet be newly generated and unused. It must not be used to restore an existing wallet's asset history. If its consistency checks fail, keep the original checkpoint and use ordinary `npm run wallet:sync`; never skip root checks.

State is stored in `.state/preprod/`. `prepare:testnet` creates owner-only seed files and a centrally held demonstration committee. This is acceptable only for disposable synthetic tests; it is not independent custody. Back up this directory securely, never commit or distribute it. Run only one wallet process per state directory.

1. Fund the printed TON address with test TON. With the official [Acton CLI](https://ton-blockchain.github.io/acton/docs/wallets) installed, set `ACTON_BINARY` to its absolute path and run `npm run fund:ton`. The generated mnemonic/config must correspond to that address. A faucet queue acknowledgment is not a balance confirmation.
2. Fund the Midnight unshielded address using the [preprod faucet](https://faucet.preprod.midnight.network/). The wallet uses the seed in `midnight-test-wallet.json`. Supply your own separately funded seed only through an owner-only `MIDNIGHT_SEED_FILE`. Initial synchronization can take a long time; checkpoints are stored in `wallet-sync.json`. DUST generation must be registered and available before fee-paying calls.
3. Generate a unique 32-byte route domain and retain it for both deployments:

```sh
export BRIDGE_DOMAIN="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
export MIDNIGHT_COMMITTEE_FILE="$PWD/.state/preprod/midnight-public-committee.json"
export TON_COMMITTEE_FILE="$PWD/.state/preprod/ton-public-committee.json"
npm run deploy:midnight
npm run deploy:ton              # inspect deterministic address plan
npm run deploy:ton -- --send
npm run verify:ton
```

The Midnight record contains its address, route domain, verifier hashes and maintenance-authority pin. Its authority has an empty committee and threshold 1: there is no maintenance key capable of upgrading it. The TON plan contains both master/escrow addresses and code/config hashes. Keep caps consistent: the supplied default is 1,000,000,000,000 integer base units per asset.

4. Exercise the entire disposable route:

```sh
npm run demo:testnet
npm run verify:testnet
```

This command requires fresh deployments. It mints fixtures, locks both assets on TON, observes registered receipts, claims on Midnight, adds liquidity, swaps, removes liquidity, retires 100 units and releases those units on TON. It verifies the source/recipient jetton message match and finalized recipient transaction. Evidence is written after each step to `.state/preprod/testnet-evidence.json`; `complete: true` appears only after every assertion passes. The demonstration committee is held on one host and is clearly labeled as such.

**If interrupted, do not delete journals or rerun blindly.** A wallet sequence change or `releaseState == 1` alone is not recipient delivery. Preserve evidence, reconcile the exact transaction, and resume only the unfinished step after determining whether it executed. See [operations](docs/operations.md). A fresh deployment record is not permission to forget funds on an earlier route.

The fixture minter can also be exercised manually:

```sh
npm run mint:ton -- 0 10000 TON_RECIPIENT
npm run mint:ton -- 0 10000 TON_RECIPIENT --send
```

Amounts are raw integer units. Asset labels do not imply official issuer recognition, dollar value, a peg or transferability outside this test route.

## SDK and liquidity

```ts
import {BridgeClient} from '@alphaton/midnight-ton-bridge/client';
const bridge = new BridgeClient(config, transport);
const body = bridge.depositMessage(0, 1000n, midnightRecipientHex, tonSender, 1n);
// Send to the sender's verified jetton wallet, with sufficient TON gas.
```

`config` contains `network: 'local' | 'preprod'`, 32-byte hex `domain`, 32-byte hex `midnightAddress`, two distinct basechain `escrows`, and three `{x: bigint, y: bigint}` committee keys. Convert JSON decimal strings to BigInt. The transport implements `call(circuit,args): Promise<string>`. An ID is not finality. Browser wallet integration is not included; the starter uses a Node backend.

Methods: `depositMessage`, `claimDigest`, `claim`, `redeem`, `quote`, `swap`, `addLiquidity`, `removeLiquidity`. Keep the small SDK because integrations need these message/receipt encodings and calls; a separate broad wallet or application SDK is unnecessary for this scope.

**Bridge collateral is separate from pool liquidity.** Users lock a token on TON before its representation can be minted on Midnight. Redemption releases that backing, so the bridge does not need an additional prefunded TON payout pool. LPs first bridge both assets, then supply their representations to the pool. Synthetic test liquidity comes from the fixture minters; real liquidity would require an identified capital provider and a separate agreement.

For LP ownership, generate a random 32-byte secret and compute `persistentHash(new CompactTypeBytes(32), secret)`. Back up the secret privately. Call `addLiquidity(ownerHash, x, y, minShares)`. The first LP chooses the price ratio; subsequent `y` must equal `ceil(x * reserve1 / reserve0)`. Excess paired donations are rejected. Shares are rounded down; the initial shares equal `x`. Swaps charge 30 bps retained in the pool. Use meaningful slippage minima. Call `removeLiquidity(secret, shares, minX, minY, recipient)` to withdraw. The contract cannot recover a lost secret. Pool reserves cannot spend permanently retired tokens.

## Deploy to mainnet — gated production handoff

**There is no supported mainnet deployment command in this release.** `BRIDGE_NETWORK=mainnet` is rejected by the SDK/provider and fixture deployment path. Replacing an RPC URL does not make these test contracts production-compatible. This boundary prevents accidentally minting lookalike USD1 or accepting valuable assets into an unreviewed route.

The future production operator must complete this sequence before a mainnet release can be implemented and deployed:

1. Agree the actual assets, issuer-approved TON master addresses, wallet code/layout, decimals, caps and initial pool ratio. The included wallet has an extra pending-transfer dictionary and a custom authenticated failure callback; it is not a generic adapter for arbitrary production jettons.
2. Implement and independently review the selected asset adapters, including missing notification, downstream bounce, issuer freeze/upgrade and rejected-transfer behavior. Rerun the full two-chain testnet suite against those exact adapter bytes. Never restore unrestricted committee recovery.
3. Obtain specialist review of the Schnorr transcript/circuit soundness and independent contract/SDK security review. Resolve findings against the exact source and verifier hashes. The 2-of-3 committee and trusted RPC model must be explicitly accepted or replaced by a different verified design.
4. Name three independent custodians, validate each public key out of band, configure independent trusted RPC/indexers, per-transfer/daily limits and stop files. Test signer outage, compromise, unavailable gas/DUST and disaster recovery. Fixed immutable committee rotation requires a new route and an accounted migration.
5. Assign infrastructure ownership, funding, monitoring, reconciliation, on-call response and service duration in writing. Test the operator's durable backups and full trace finalization. The repository provides manual CLI operations; it does not imply an always-running hosted service.
6. Add a separately reviewed production network configuration and release authorization to the SDK/deploy tools, with official asset allowlists and fixture minters excluded. Pin approved compiler, proof service and network protocol versions. Generate a new domain and fresh production keys; never reuse demonstration secrets or addresses.
7. Deploy Midnight with the reviewed immutable authority; deploy the approved TON adapters; verify every address, code hash, verifier hash, authority and cap independently. Publish the approved release manifest and user-visible asset/network labels.
8. With explicit funding authorization, perform the smallest approved lock/claim/retire/release canary, verify recipient delivery and backing conservation, then add separately approved LP capital and raise caps gradually. Record rollback/migration instructions and signed acceptance.

These are unresolved production prerequisites, not completed work or a claim that mainnet hosting is contractually owed. If the accepted contract scope is code plus a working synthetic test demonstration, deliver that scope and keep mainnet operations with the appointed recipient.

## Security, incidents and delivery

Read [security review](docs/security-review.md), [operations](docs/operations.md), [architecture](docs/architecture.md), [validation](docs/validation.md), [acceptance](docs/acceptance.md) and the [notes starter](examples/notes/README.md). Transfers are unshielded and linkable; the starter is not an on-chain private-note application.

To stop new committee authorizations, create the configured stop file on each signer. This does not cancel already signed authorizations. Keep signed-message journals and LP secrets during incidents. No administrator can upgrade the new Midnight deployment or drain registered backing through a refund. Two colluding committee members can still authorize fraudulent mint/release: operational separation is essential.

```sh
npm run check
npm run manifest
mkdir -p tmp
npm pack --json --pack-destination tmp > tmp/pack.json
node scripts/check-package.mjs tmp/pack.json
```

Deliver the reviewed commit, source/lockfile, SDK package, hashes, deployment records stripped of secrets, test/benchmark evidence and agreed audit artifacts through the private repository. Supply the required independent-developer build, demo recording, approved review PDF/IPFS reference and written Foundation acceptance. The repository alone does not complete these external acceptance steps. Do not include the signed commercial agreement, `.state`, `.env`, wallet snapshots, LP secrets or committee keys in a software package.
