# Midnight–TON bridge — engineering handoff

This repository implements a **bidirectional Midnight–TON token bridge**: two allowlisted TON jetton escrows, Midnight token representations and redemption, a two-asset liquidity pool, a TypeScript SDK, committee signers, relayer commands, recovery tools and a notes starter. The bridge is currently deployed on **TON testnet and Midnight preprod**. It is Apache-2.0 licensed. The GitHub repository is private; changing its visibility is a separate release decision.

**Verified on 2026-09-14:** the full public round trip passed against the unmodified TON reference jetton wallet: lock, claim, add liquidity, swap, withdraw liquidity, redeem and return. Independent readback confirmed recipient delivery and matched backing to circulation. See [current evidence](docs/standard-testnet-evidence.json), [deployment addresses](docs/standard-testnet-deployment.json) [testnet asset registry](docs/standard-testnet-assets.json) and [settled accounting check](docs/standard-testnet-accounting.json). The earlier wallet integration's [evidence](docs/testnet-evidence.json) is preserved separately.

**Network boundary:** testnet deployment does not limit the bridge to a mock protocol. Existing compatible token masters can be configured without mint authority. The tokens issued for network testing are valueless and are not issuer-approved WHIS or USD1. Mainnet broadcasting remains disabled pending the production asset, security and operational release checks below. See [validation](docs/validation.md) for actual evidence and [security review](docs/security-review.md) for remaining trust assumptions. Passing tests does not establish an independent audit or Foundation acceptance.

## What is delivered

| Component | Behavior |
| --- | --- |
| TON contracts | Authenticated deposit receipts; quorum release; replay protection; exact-sender refunds for malformed/cap-exceeding deposits; immediate bounce recovery and quorum-attested downstream bounce recovery for standard reference wallets |
| Midnight contract | Quorum mint authorization, permanent retirement of representations, circulating caps, separate pool reserves, swaps and secret-authorized LP withdrawals |
| SDK | Deposit payloads, claim validation, redemption, swap quotes, liquidity calls and a Node provider |
| Operator tools | Independent chain observation, verifier/config pins, durable signing quotas, equivocation rejection and a stop file |
| Persistence | Exact transaction bytes before broadcast, ambiguous-send reconciliation, network-specific secret state and wallet sync checkpoints |
| Verification | Compiled Compact tests, TON TVM tests, adversarial inputs, real local proof transactions, public testnet deployment tools and Linux CI |

This is a code handover. A live service additionally needs an assigned operator, independent key custody, funded gas/DUST, monitoring and incident response. Real LP capital and indefinite bridge hosting are not silently included. The private agreement analysis and proposed clarification remain in the local ignored `output/` folder and are excluded from software distribution. Obtain written acceptance of the bridge deliverables and the testnet demonstration; separate federated-node duties remain separate. The whistleblower Telegram application is excluded.

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

State is stored in `.state/preprod/`. `prepare:testnet` creates owner-only seed files and a centrally held demonstration committee. This arrangement is for testnet validation; it is not independent custody. Back up this directory securely, never commit or distribute it. Run only one wallet process per state directory.

1. Fund the printed TON address with test TON. With the official [Acton CLI](https://ton-blockchain.github.io/acton/docs/wallets) installed, set `ACTON_BINARY` to its absolute path and run `npm run fund:ton`. The generated mnemonic/config must correspond to that address. A faucet queue acknowledgment is not a balance confirmation.
2. Fund the Midnight unshielded address using the [preprod faucet](https://faucet.preprod.midnight.network/). The wallet uses the seed in `midnight-test-wallet.json`. Supply your own separately funded seed only through an owner-only `MIDNIGHT_SEED_FILE`. Initial synchronization can take a long time; checkpoints are stored in `wallet-sync.json`. DUST generation must be registered and available before fee-paying calls.
3. Generate a unique 32-byte route domain and retain it for both deployments:

```sh
export BRIDGE_DOMAIN="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
export MIDNIGHT_COMMITTEE_FILE="$PWD/.state/preprod/midnight-public-committee.json"
export TON_COMMITTEE_FILE="$PWD/.state/preprod/ton-public-committee.json"
npm run deploy:midnight
# Existing approved token masters: set the asset registry first.
export BRIDGE_ASSETS_FILE="$PWD/assets.json"
npm run deploy:bridge-ton              # validate masters and inspect address plan
npm run deploy:bridge-ton -- --send
npm run verify:ton
```

For an entirely new testnet environment with no existing token masters, issue two tokens using the **unmodified TON reference minter and wallet**. This uses the same bridge adapter as the existing-master path:

```sh
unset BRIDGE_ASSETS_FILE
npm run deploy:bridge-ton -- --issue-testnet-tokens
npm run deploy:bridge-ton -- --issue-testnet-tokens --send
npm run verify:ton
```

Use one deployment path per state directory. Token issuance is an explicit testnet setup option, not a bridge requirement. Never represent these token masters as official WHIS or USD1.

The Midnight record contains its address, route domain, verifier hashes and maintenance-authority pin. Its authority has an empty committee and threshold 1: there is no maintenance key capable of upgrading it. The TON plan contains both master/escrow addresses and code/config hashes. Keep caps consistent: the supplied default is 1,000,000,000,000 integer base units per asset.

4. Exercise the entire bridge on the new testnet route:

```sh
npm run demo:testnet  # tokens issued by the explicit testnet setup
# Existing masters instead: npm run demo:testnet -- --existing-balances
npm run verify:testnet
npm run reconcile:ton -- all
npm run check:route
```

This command requires a fresh bridge deployment. For existing masters, fund the sender with at least 10,000 base units of each configured token and pass `--existing-balances`; the bridge does not mint underlying assets. With explicit testnet issuance it obtains tokens from those testnet minters. It locks both assets on TON, observes registered receipts, claims on Midnight, adds liquidity, swaps, removes liquidity, retires 100 units and releases those units on TON. It verifies the source/recipient jetton message match and finalized recipient transaction. Evidence is written after each step to `.state/preprod/testnet-evidence.json`; `complete: true` appears only after every assertion passes. The demonstration committee is held on one host and is clearly labeled as such.

**If interrupted, do not delete journals or rerun blindly.** A wallet sequence change or `releaseState == 1` alone is not recipient delivery. Preserve evidence, reconcile the exact transaction, and resume only the unfinished step after determining whether it executed. See [operations](docs/operations.md). A fresh deployment record is not permission to forget funds on an earlier route.

## Configure token masters

`BRIDGE_ASSETS_FILE` is a JSON array of exactly two assets, ordered by `asset` 0 and 1. Each entry contains:

| Field | Required value |
| --- | --- |
| `asset`, `symbol`, `decimals` | Index 0/1 and display metadata; metadata is not identity |
| `master` | Approved basechain TON master address |
| `masterCodeHash` | Pinned 32-byte lowercase hex master code hash |
| `walletCodeBoc`, `walletCodeHash` | Base64 wallet bytecode and its pinned 32-byte hex hash |
| `adapter` | `tep74-reference` |
| `cap` | Positive uint64 limit in base units, encoded as a decimal string |

The adapter derives wallets from `balance, owner, master, wallet_code` reference storage. Deployment checks the master's `get_wallet_address`, `get_jetton_data`, code pins and any already deployed wallet's owner/master/code. An unsupported layout fails closed. TEP-74 standardizes interfaces, **not storage or issuer behavior**; a token using a different layout or freeze/upgrade logic needs its own reviewed adapter. Never choose an asset from its ticker alone. The [asset API](src/jettons.ts) exports validation and these checks for integrations.

The two Midnight asset slots preserve integer base units; no decimal conversion occurs across the bridge. Caps must be coordinated across both chains. Asset decimals affect display and initial pool pricing. The public deployment records contain the actual testnet master addresses and code pins.

## SDK and liquidity

```ts
import {BridgeClient} from '@alphaton/midnight-ton-bridge/client';
const bridge = new BridgeClient(config, transport);
const body = bridge.depositMessage(0, 1000n, midnightRecipientHex, tonSender, 1n);
// Send to the sender's verified jetton wallet, with sufficient TON gas.
```

`config` contains `network: 'local' | 'preprod'`, 32-byte hex `domain`, 32-byte hex `midnightAddress`, two distinct basechain `escrows`, and three `{x: bigint, y: bigint}` committee keys. Convert JSON decimal strings to BigInt. The transport implements `call(circuit,args): Promise<string>`. An ID is not finality. Browser wallet integration is not included; the starter uses a Node backend.

Methods: `depositMessage`, `claimDigest`, `claim`, `redeem`, `quote`, `swap`, `addLiquidity`, `removeLiquidity`. Keep the small SDK because integrations need these message/receipt encodings and calls; a separate broad wallet or application SDK is unnecessary for this scope.

**Bridge collateral is separate from pool liquidity.** Users lock a token on TON before its representation can be minted on Midnight. Redemption releases that backing, so the bridge does not need an additional prefunded TON payout pool. LPs first bridge both assets, then supply their representations to the pool. Testnet liquidity can come from the explicitly issued tokens. Liquidity for valuable assets requires an identified capital provider and a separate agreement.

For LP ownership, generate a random 32-byte secret and compute `persistentHash(new CompactTypeBytes(32), secret)`. Back up the secret privately. Call `addLiquidity(ownerHash, x, y, minShares)`. The first LP chooses the price ratio; subsequent `y` must equal `ceil(x * reserve1 / reserve0)`. Excess paired donations are rejected. Shares are rounded down; the initial shares equal `x`. Swaps charge 30 bps retained in the pool. Use meaningful slippage minima. Call `removeLiquidity(secret, shares, minX, minY, recipient)` to withdraw. The contract cannot recover a lost secret. Pool reserves cannot spend permanently retired tokens.

## Deploy to mainnet — gated production handoff

**There is no supported mainnet deployment command in this release.** `BRIDGE_NETWORK=mainnet` is rejected by the SDK/provider and deployment paths. The bridge logic and reference-wallet integration run on testnet. Production activation requires reviewed assets, independent custody and a separately approved network configuration; changing an RPC URL does not satisfy those requirements.

The future production operator must complete this sequence before a mainnet release can be implemented and deployed:

1. Agree the actual assets, issuer-approved TON master addresses, wallet code/layout, decimals, caps and initial pool ratio. The current bridge adapter supports reference-layout wallets and does not require the legacy custom pending-transfer dictionary or callback. Asset-specific freeze, upgrade and fee behavior still needs review.
2. Verify the selected assets against the implemented reference adapter; implement a separate adapter only where their behavior differs. Independently review missing notifications, downstream bounce, issuer freeze/upgrade and rejected-transfer behavior. Rerun the full two-chain testnet suite against those exact adapter bytes. Never restore unrestricted committee recovery.
3. Obtain specialist review of the Schnorr transcript/circuit soundness and independent contract/SDK security review. Resolve findings against the exact source and verifier hashes. The 2-of-3 committee and trusted RPC model must be explicitly accepted or replaced by a different verified design.
4. Name three independent custodians, validate each public key out of band, configure independent trusted RPC/indexers, per-transfer/daily limits and stop files. Test signer outage, compromise, unavailable gas/DUST and disaster recovery. Fixed immutable committee rotation requires a new route and an accounted migration.
5. Assign infrastructure ownership, funding, monitoring, reconciliation, on-call response and service duration in writing. Test the operator's durable backups and full trace finalization. The repository provides manual CLI operations; it does not imply an always-running hosted service.
6. Add a separately reviewed production network configuration and release authorization to the SDK/deploy tools, with official asset allowlists and testnet issuance excluded. Pin approved compiler, proof service and network protocol versions. Generate a new domain and fresh production keys; never reuse demonstration secrets or addresses.
7. Deploy Midnight with the reviewed immutable authority; deploy the approved TON adapters; verify every address, code hash, verifier hash, authority and cap independently. Publish the approved release manifest and user-visible asset/network labels.
8. With explicit funding authorization, perform the smallest approved lock/claim/retire/release canary, verify recipient delivery and backing conservation, then add separately approved LP capital and raise caps gradually. Record rollback/migration instructions and signed acceptance.

These are unresolved production prerequisites, not completed work or a claim that mainnet hosting is contractually owed. Deliver the full bridge code and testnet evidence under the agreed acceptance process, and assign production operation responsibilities explicitly.

## Failed transfers and accounting

`npm run check:route` verifies current asset/escrow pins, Midnight verifier/authority pins, per-asset wallet backing versus escrow accounting and Midnight circulation, and transaction journals. It exits nonzero on unsettled accounting or unresolved sends. The chains are sampled independently: run after operations settle and investigate differences; never automatically mint or release to force equality.

For the standard adapter, a downstream bounce returns tokens to the escrow's jetton wallet but does not notify the escrow. Its release remains pending until two operators independently verify the exact source → rejected recipient → successful bounce trace:

```sh
npm run recover:standard -- operator-config.json failure-request.json > attestation-a.json
# A second independent operator produces attestation-b.json with its own configuration.
npm run relay:failure -- relay-config.json attestation-a.json attestation-b.json
npm run relay:failure -- relay-config.json attestation-a.json attestation-b.json --send
```

See [standard recovery](docs/standard-recovery.md) for the JSON schemas and reconciliation sequence. Restoration only reopens the existing pending release/refund; it cannot select a different payout. A timeout is not failure evidence. Retry the original authorized transfer only after restoration finalizes. Never restore a transfer already delivered.

Users must send a valid deposit payload with the SDK's notification gas. A direct mint to escrow or a transfer with no successful notification does not produce a claimable receipt. Such funds require incident investigation; no arbitrary administrator withdrawal exists. The bridge does not advertise support for every jetton implementation.

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

## Monitoring and handoff packaging

The [monitoring service](docs/monitoring.md) provides persistent health checks,
loopback HTTP health/Prometheus endpoints and alert-rule templates. It neither
reads wallet keys nor signs or submits transactions. After building, run
`npm run monitor` under the appointed operator's service manager.

[Measured timings](docs/benchmarks.json) report the six actual public testnet
calls without claiming throughput or an SLA. Follow [delivery packaging](docs/delivery-artifacts.md)
to produce the source/SDK bundle, standalone starter, narrated evidence walkthrough
and review CID. [External release inputs](docs/external-release-inputs.md) identifies
exactly which issuer decisions, independent reviews and acceptance signatures
still require the responsible parties.

Standalone starter: [AlphaCompute/midnight-ton-bridge-starter](https://github.com/AlphaCompute/midnight-ton-bridge-starter) (private). It vendors the SDK package and can be cloned and tested without this checkout.
