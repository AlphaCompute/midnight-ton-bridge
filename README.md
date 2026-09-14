# Midnight–TON test-asset bridge

A test-asset reference implementation for AlphaTON: two TON jetton escrows, a Midnight representation with permanent retirement, a WHIS/test-USD1 constant-product pool, a TypeScript SDK, committee tooling, durable transaction bookkeeping and a notes starter.

This is a **trusted 2-of-3 committee POC**. The included WHIS and test-USD1 minters are synthetic fixtures. It has not received an independent security audit or Foundation acceptance. Never send real USD1 or valuable assets to it. Read [validation](docs/validation.md) for the exact evidence and remaining gates.

## Build and test

Requirements: Node.js 22.18+ (tested with 24), npm, bash, curl, tar, shasum; Docker for local proof-backed transactions. Compact 0.31.1 / runtime 0.16.0 / ledger 8.1.0 and onchain-runtime-v3 3.0.0 are deliberately pinned together. Do not upgrade one in isolation: two installed onchain-runtime WASM versions produce incompatible StateValue instances. Runtime commands load an optional root `.env`.

```sh
bash scripts/bootstrap.sh
npm run check
npm --prefix examples/notes install
npm --prefix examples/notes test
```

The bootstrap verifies the Compact manager release checksum and installs the compiler. `npm run compile:midnight` compiles runtime bindings; `npm run compile:ton` compiles all three Tolk contracts. To regenerate proving keys:

```sh
npm run compile:midnight -- --proof
```

Key generation can take many minutes and substantial RAM. A source fingerprint prevents an unchanged runtime-only build from deleting existing keys. Do not change Compact source while key generation is running. Key files must all be nonempty before deployment.

## Local chain demonstration

```sh
docker compose up -d
npm run compile:midnight -- --proof
npm run deploy:midnight
npm run demo:local
```

On Docker Desktop versions where negotiated API calls fail, the tested compatibility setting is `DOCKER_API_VERSION=1.44`. Services bind to loopback ports 19944, 18088 and 16300. The local genesis wallet is public test infrastructure; it must never be reused on another network. `.state` contains private committee, wallet, maintenance and LP keys, signed transactions and local evidence; it is ignored and must not be distributed.

The proof demonstration exercises all five Midnight circuits with local synthetic claims. The combined `tests/ton.test.ts` exercises actual TON TVM execution and the compiled Midnight runtime round trip. These are different validation layers; neither is a claim of a public two-chain deployment.

Deployment and demo scripts fail on existing state rather than silently duplicating transfers. For an interrupted run, follow [operations](docs/operations.md). Stop only this project's services with `docker compose down` when finished.

## SDK

```ts
import {BridgeClient} from '@alphaton/midnight-ton-bridge/client';
const bridge = new BridgeClient(config, transport);
const body = bridge.depositMessage(0, 1000n, midnightRecipientHex, tonSender, 1n);
// Send body to the sender's verified jetton wallet with sufficient TON gas.
// Never send this jetton transfer payload directly to the escrow.
```

`config` contains `network` (`local` or `preprod`), a 32-byte hex `domain`, a 32-byte hex `midnightAddress`, two distinct basechain `escrows`, and three `{x: bigint, y: bigint}` committee keys. Convert JSON decimal strings back to BigInt. The transport implements `call(circuit,args): Promise<string>`; returning an ID means submission, not finality. The Node provider supplies finality-aware calls and an exact-transaction journal. Browser wallet integration is not included; the supplied starter uses a Node backend.

Methods: `depositMessage`, `claimDigest`, `claim`, `redeem`, `quote`, `swap`, `addLiquidity`, `removeLiquidity`. Amounts are integer base units, positive uint64 except withdrawal minima may be zero. The LP owner is `persistentHash(new CompactTypeBytes(32), secret)`; keep that random 32-byte secret private and backed up. No admin can recover a lost LP secret through the pool circuits.

See [architecture](docs/architecture.md), [operations and liquidity](docs/operations.md), [acceptance checklist](docs/acceptance.md), and [notes starter](examples/notes/README.md). The whistleblower application is outside this repository's scope.

## Delivery

```sh
npm run build
npm pack --pack-destination tmp
```

Deliver the source, lockfile, tarball, docs, test evidence and agreed audit artifacts privately to the Foundation, with an agreed Apache-2.0 open-source release. No remote repository changes or publication are implied by preparing this package. Contract interpretation and proposed scope amendments remain in the ignored local `output` folder, outside software distribution.
