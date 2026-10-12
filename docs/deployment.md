# Deployment guide

Detailed setup, wallet initialization, token configuration and production release procedure for the Midnight–TON bridge. Start with the [project README](../README.md) for the architecture and SDK overview.

## Build from a clean checkout

Use Node 24 (22.18+ minimum; CI runs Node 24), npm, bash, curl, tar and shasum. Docker is needed for local chain/proof services. Supported bootstrap hosts: Linux x86-64/ARM64 and macOS Intel/ARM64. `scripts/toolchain.env` pins the Compact compiler (bootstrap verifies its archive checksums); the lockfile pins the complete npm dependency graph. The Compact compiler, Compact runtime, ledger and onchain-runtime packages must remain compatible; do not independently upgrade a WASM runtime. Changing the Compact version changes verifier keys and therefore requires a new deployment.

```sh
git clone git@github.com:AlphaCompute/midnight-ton-bridge.git
cd midnight-ton-bridge
bash scripts/bootstrap.sh
npm run check
npm --prefix examples/notes ci
npm --prefix examples/notes test
npm run compile:midnight -- --proof
npm run release -- manifest
```

Proof-key generation takes several minutes and substantial memory. All five `.prover` and `.verifier` files under `build/midnight/keys/` must be nonempty. Build/test reject stale Compact bindings. Do not modify Compact source while generating keys: recompilation replaces its artifacts. Review [`docs/evidence/build-manifest.json`](evidence/build-manifest.json) after every release build. Packaging the handoff is described in [release](release.md#build-the-private-handoff).

## Deploy to local test networks

```sh
docker compose up -d --wait
export BRIDGE_NETWORK=local
export BRIDGE_STATE_DIR="$PWD/.state/local-demo"
npm run deploy:midnight
npm run demo:local
npm run verify:local
```

Compose binds only loopback ports 19944 (node), 18088 (indexer), 16300 (proof server). On older Docker Desktop API negotiations, prepend `DOCKER_API_VERSION=1.44`. Only the node service has a healthcheck: `--wait` waits for the node to be healthy and for the indexer and proof server containers to start, not for them to be ready. If `deploy:midnight` fails against a still-starting indexer or proof server, wait briefly and retry. On local, `deploy:midnight` draws a random route domain when `BRIDGE_DOMAIN` is unset. `verify:local` checks exact outcomes and writes [`docs/evidence/local-proof.json`](evidence/local-proof.json); it does not merely check that services are healthy. Preserve containers if you need their chain history: `docker compose stop`. Recreating the development node may create a fresh chain, invalidating old deployment records.

Local claims are deliberately synthetic. TON execution is covered separately by the combined TVM/Compact test. The local seed is public development infrastructure and must never be used on another network.

## Deploy to public testnet

Public testnet means **TON testnet + Midnight preprod**. Midnight retired its hosted preprod indexer and RPC on 9 October 2026; preprod is now served by [Blockfrost](https://docs.midnight.network/guides/networks-and-environments#blockfrost-the-mainnet-indexer-and-rpc-provider). Create a free Blockfrost project for **Midnight Preprod** and add `BLOCKFROST_PROJECT_ID=nightpreprod…` to `.env` (gitignored; `chmod 600 .env`). Every npm command loads `.env` and derives its node and indexer URLs from it; output is redacted so the token never reaches logs. Signer configurations (`indexer`, `indexerWS`) must use the same Blockfrost URLs with `?project_id=`. Keep the token out of logs and shared files. Start only the proof server when using public Midnight endpoints. Avoid a local `.env` overriding public URLs: the default `.env.example` intentionally leaves endpoint overrides commented out.

```sh
export BRIDGE_NETWORK=preprod
unset MIDNIGHT_NETWORK BRIDGE_STATE_DIR
npm run prepare:testnet
docker compose up -d proof-server
npm run compile:midnight -- --proof
npm run compile:ton
```

For a newly generated wallet that has never received shielded assets or generated DUST, use the fast initialization. Replaying preprod history instead takes hours, because Blockfrost drops long-running event streams and the wallet must reconnect repeatedly. The fast initialization verifies all three collapsed Merkle roots against a canonical block and checks that there are no DUST generations. Run it only once, immediately after preparation:

```sh
npm run wallet:sync -- --initialize-only
npm run bootstrap:wallet -- --new-unused-wallet
```

The helper checks local usage history, active locks, on-chain DUST generations and a recent fresh-wallet marker. Those checks do not replace the requirement that the wallet be newly generated and unused. It must not be used to restore an existing wallet's asset history. If its consistency checks fail, keep the original checkpoint and use ordinary `npm run wallet:sync`; never skip root checks.

State is stored in `.state/preprod/`. `prepare:testnet` creates owner-only seed files and a centrally held demonstration committee. This arrangement is for testnet validation; it is not independent custody. Back up this directory securely, never commit or distribute it. Run only one wallet process per state directory.

1. Fund the printed TON address with about 3 test TON. Install the official [Acton CLI](https://github.com/ton-blockchain/acton/releases) into `.tools/acton` (the default `ACTON_BINARY`), then request an airdrop:

   ```sh
   base=https://github.com/ton-blockchain/acton/releases/download/v1.2.1
   file=acton-aarch64-apple-darwin.tar.gz   # pick the asset for your platform
   mkdir -p .tools/acton && curl -fsSLO "$base/$file" && curl -fsSL "$base/$file.sha256" | shasum -a 256 -c - && tar -xzf "$file" -C .tools/acton && rm "$file"
   npm run fund:ton
   ```

   One airdrop gives 2 TON. The faucet refuses a second claim until the wallet has sent its first transaction, so request again after the TON deployment below. A queue acknowledgment is not a balance confirmation.
2. Fund the Midnight unshielded address using the [preprod faucet](https://faucet.preprod.midnight.network/) (it asks for a browser human check). Then run `npm run wallet:sync`: it synchronizes, registers the tNIGHT for DUST generation and waits until DUST is available. The wallet uses the seed in `midnight-test-wallet.json`. Supply your own separately funded seed only through an owner-only `MIDNIGHT_SEED_FILE`. Initial synchronization can take a long time; checkpoints are stored in `wallet-sync.json`. DUST generation must be registered and available before fee-paying calls.
3. Generate a unique 32-byte route domain, keep it in the state directory and reuse it for both deployments (source the file again in any new shell). On preprod `deploy:midnight` refuses to run without `BRIDGE_DOMAIN`:

```sh
node -e "process.stdout.write('BRIDGE_DOMAIN='+require('crypto').randomBytes(32).toString('hex')+'\\n')" > .state/preprod/route.env
set -a; . .state/preprod/route.env; set +a
export MIDNIGHT_COMMITTEE_FILE="$PWD/.state/preprod/midnight-public-committee.json"
export TON_COMMITTEE_FILE="$PWD/.state/preprod/ton-public-committee.json"
npm run deploy:midnight
# Existing approved token masters: set the asset registry first.
export BRIDGE_ASSETS_FILE="$PWD/assets.json"
npm run deploy:ton              # validate masters and inspect address plan
npm run deploy:ton -- --send
npm run verify:ton
```

For an entirely new testnet environment with no existing token masters, issue two tokens using the **unmodified TON reference minter and wallet**. This uses the same bridge adapter as the existing-master path:

```sh
unset BRIDGE_ASSETS_FILE
npm run deploy:ton -- --issue-testnet-tokens
npm run deploy:ton -- --issue-testnet-tokens --send
npm run verify:ton
```

Use one deployment path per state directory. Token issuance is an explicit testnet setup option, not a bridge requirement. Never represent these token masters as official WHIS or USD1. `deploy:ton` deploys only the reference-wallet adapter; the legacy fixture-wallet route is no longer deployable (see [architecture](architecture.md#legacy-fixture-wallet-route)).

The Midnight record contains its address, route domain, verifier hashes and maintenance-authority pin. Its authority has an empty committee and threshold 1: there is no maintenance key capable of upgrading it. The TON plan contains both master/escrow addresses and code/config hashes. Keep caps consistent: the supplied default is 1,000,000,000,000 integer base units per asset.

4. Exercise the entire bridge on the new testnet route:

```sh
npm run demo:testnet  # tokens issued by the explicit testnet setup
npm run demo:unrecorded   # live underfunded deposit, quorum recovery and refund
# Existing masters instead: npm run demo:testnet -- --existing-balances
npm run verify:testnet
npm run reconcile:ton -- all
npm run check:route
```

This command requires a fresh bridge deployment. For existing masters, fund the sender with at least 10,000 base units of each configured token and pass `--existing-balances`; the bridge does not mint underlying assets. With explicit testnet issuance it obtains tokens from those testnet minters. It locks both assets on TON, observes registered receipts, claims on Midnight, adds liquidity, swaps, removes liquidity, retires 100 units and releases those units on TON. It verifies the source/recipient jetton message match and finalized recipient transaction. Evidence is written after each step to `.state/preprod/testnet-evidence.json`; `complete: true` appears only after every assertion passes. `demo:testnet` refuses to start while a prior attempt's evidence exists. `verify:testnet` independently re-reads the completed run and writes the public records [`docs/evidence/testnet-transactions.json`](evidence/testnet-transactions.json) and [`docs/evidence/testnet-deployment.json`](evidence/testnet-deployment.json). The demonstration committee is held on one host and is clearly labeled as such.

**If interrupted, do not delete journals or rerun blindly.** Follow [reconciliation](operations.md#relay-and-reconciliation) and resume only the unfinished step. A fresh deployment record is not permission to forget funds on an earlier route.

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

The adapter derives wallets from `balance, owner, master, wallet_code` reference storage. Deployment checks the master's `get_wallet_address`, `get_jetton_data`, code pins and any already deployed wallet's owner/master/code. An unsupported layout fails closed. TEP-74 standardizes interfaces, **not storage or issuer behavior**; a token using a different layout or freeze/upgrade logic needs its own reviewed adapter. Never choose an asset from its ticker alone. The [asset API](../src/jettons.ts) exports validation and these checks for integrations.

The two Midnight asset slots preserve integer base units; no decimal conversion occurs across the bridge. Caps must be coordinated across both chains. Asset decimals affect display and initial pool pricing. [`docs/evidence/testnet-assets.json`](evidence/testnet-assets.json) is a sample `BRIDGE_ASSETS_FILE` for the public testnet route's valueless test tokens; [`docs/evidence/testnet-deployment.json`](evidence/testnet-deployment.json) records its actual master/escrow addresses and code pins.

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
