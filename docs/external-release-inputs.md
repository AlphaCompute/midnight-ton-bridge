# External release inputs and sign-off

Engineering can prepare and verify the implementation and artifacts. The following
items require authoritative input or action by the named party; none is marked
complete solely because a repository, test or AI-generated report exists.

| Item | Required owner/action | Prepared evidence |
| --- | --- | --- |
| Actual WHIS and USD1 assets | Issuers/Foundation provide approved master addresses, code versions, decimals and freeze/upgrade policy | Asset registry schema, reference adapter, live existing-master validation |
| Independent security review | A separate qualified reviewer examines exact source/verifier hashes and resolves findings | Security review PDF, tests, failure traces, source manifest |
| Production custody | Three independent operators supply verified public keys, key handling and recovery procedures | Key generation, signer policy, route pins and immutable committee design |
| Node/service obligations | Appointed infrastructure owner accepts service duration, uptime, gas/DUST budget and incident response | Monitoring service/template, recovery runbook, deployment instructions |
| Mainnet release | Foundation/operator approve reviewed assets and production network configuration | Gated README sequence; broadcasting remains disabled |
| Independent developer build | A separate developer clones the starter and records a successful build on their machine | Separately packaged starter, SDK tarball and clean-consumer checks |
| Loom demonstration | Authorized account uploads/reviews the narrated recording or records an attended live demonstration | Local MP4 and transcript; clearly identified as finalized-evidence walkthrough |
| IPFS review delivery | Authorized publishing/pinning operator uploads exact approved PDF and verifies retrieval/pin retention | PDF, SHA-256 and offline raw-block CID; local CID alone is not publication |
| Foundation acceptance | Foundation provides explicit written component/overall acceptance | Acceptance checklist and complete private handoff bundle |
| Real liquidity | Named capital provider agrees amounts, ownership, fees and withdrawal terms | LP API and testnet swap/withdrawal evidence |

No invented issuer approval, audit signature, custodian identity, Loom URL, IPFS
publication or Foundation acceptance is included. Continuous node obligations
remain separate from bridge code delivery. A new route is required for committee
rotation; no unreviewed administrator drain or in-place key takeover is added.
