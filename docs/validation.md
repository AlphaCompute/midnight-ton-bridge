# Validation record

Date: 2026-09-14. Status: **local test-asset POC validated; public deployment and contractual acceptance outstanding**. These results do not establish production safety or an independent audit pass.

## Completed checks

| Check | Observed result |
|---|---|
| Strict TypeScript build | Passed |
| Tolk 1.4.2 compilation | Escrow, fixture wallet and fixture minter compiled |
| Compact 0.31.1 compilation | Five circuits compiled with runtime 0.16.0 |
| Proving-key generation | All five prover/verifier pairs generated successfully |
| Automated suite | Seven tests passed, zero failed |
| Combined bridge path | TON Sandbox TVM lock → compiled Midnight runtime claim → retirement → signed TON release passed; backing/circulation checked |
| Adversarial cases | Invalid quorum/signature, changed domain/address/asset/recipient/amount, replay, cap, forged notification, low gas, malformed deposit recovery, impossible recovery bounce, pool slippage, LP secret and durable restart checks passed |
| Local Midnight deployment | Successful finalized deployment at the address in local-proof-evidence.json |
| Proof-backed execution | Two claims, addLiquidity, swap, removeLiquidity and redeem all SucceedEntirely |
| Independent final-state read | Six transaction outcomes re-read from the local indexer; final pool reserves zero, shares zero, circulation 9,900 WHIS / 10,000 test-USD1, one retirement |
| Reverse observer validation | Actual retired commitment matched; altered amount, maintenance authority and verifier fingerprint rejected |
| Durable live journal | Seven entries confirmed: deployment plus six calls; zero ambiguous entries at completion |
| SDK/starter distribution | Packed tarball installed in a fresh temporary directory and notes test passed without a checkout-relative package symlink |
| Package privacy check | Package inventory excludes .state, .tools, node_modules, private output and .env |
| Dependencies | npm audit during installation reported zero known vulnerabilities; this is not a source-code audit |
| Compose | Configuration validated; local node, indexer and proof server ran successfully |
| Review PDF | Two pages rendered and visually checked |

Machine: macOS ARM64, Node 24.15.0, npm 11. Toolchain: Compact 0.31.1, compact-runtime 0.16.0, onchain-runtime-v3 3.0.0, Midnight JS 4.1.1, ledger-v8 8.1.0, Tolk 1.4.2, TON Sandbox 0.44.0. Local images: midnight-node 1.0.0, indexer-standalone 4.3.3, proof-server 8.1.0. The direct onchain-runtime pin is necessary to avoid incompatible WASM StateValue instances from duplicate runtime versions.

The clean-directory check was run by the implementing agent on this same machine. It does **not** satisfy the separate requirement for a third party to reproduce the scaffold on another machine. The live demonstration used centrally held local test keys and synthetic receipts; it was not an independently operated public TON-to-Midnight deployment.

## Evidence and reproduction

- `npm run check`: strict build and seven automated tests.
- `npm run compile:midnight -- --proof`: regenerate all proof material from source.
- `npm run deploy:midnight` then `npm run demo:local`: on a fresh isolated local setup, exercise all five circuits. Existing deployment/demo guards prevent blind duplication.
- `npm run validate:local`: independently re-read the six transactions, compare final ledger state and test reverse-observer tampering rejection.
- `docs/local-proof-evidence.json`: local deployment address, accepted verifier/maintenance pins, six transaction IDs, block heights/hashes and final state. Block heights 289, 296, 305, 310, 315 and 320 were all successful.
- `npm run manifest`: SHA-256 fingerprints of source, tests, build configuration and generated TON/proof artifacts in `docs/build-manifest.json`. Regenerate after any source or dependency change.
- `npm pack --json`: inspect with `node scripts/check-package.mjs PACK_JSON`; install the resulting tarball in a fresh starter directory and run its test.

Prover files are deliberately regenerated rather than embedded in the small SDK tarball. Generated runtime bindings are included. Source delivery includes scripts and the npm lockfile; a tarball consumer must rebuild proof assets before deploying.

## Performance observations

The first local claim took approximately 46 seconds from a synchronized wallet to successful finalization. Its proof-server request took about 21.5 seconds including fetching/verifying public parameters; a separate transaction proof request took about 1.2 seconds. The observed swap circuit proof request took about 4.0 seconds plus another approximately 0.9-second transaction proof request. These are individual local observations under shared-machine load, not a throughput benchmark, percentile latency claim or agreed SLA. Wallet synchronization adds separate delay. Public-network gas/DUST and throughput targets remain unmeasured.

## Remaining release and acceptance gates

1. Foundation agreement on software handover, accepted test network, trusted quorum, synthetic USD1, pool configuration and responsibility for deployment/operation/liquidity.
2. An agreed two-chain acceptance demonstration using the delivered software, with real test-network evidence if required. Public testnet deployment/funding, independent signer endpoints and TON recipient-trace finalization have not been performed here.
3. Independent-machine starter build and any agreed on-chain private-note/Telegram integration beyond the minimal starter.
4. Review of the open security findings and the required passing security-review decision; an external specialist review before valuable assets.
5. Measured benchmarks against agreed thresholds, narrated Loom video, approved review PDF/IPFS publication, tagged private repository delivery and written Foundation acceptance.
6. Separate evidence for continuous node operations, reports and SLA obligations; this implementation does not fulfill those service duties.

No real liquidity was supplied. No public bridge deployment, remote Git push, IPFS upload or Loom publication was performed. The local chain remains a development environment, not a production service.

After validation, only this project's Compose services were stopped, preserving their containers and local chain state. Resume them with `docker compose start`; `docker compose down` would remove those containers.
