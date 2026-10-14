# Notes starter

A minimal Node-backed web example. It keeps note plaintext in local process memory (never on chain) and uses the bridge SDK client to prepare an unsigned jetton deposit with a Midnight recipient. It has no authentication, hosted storage, fees, custodial wallet or automatic submission.

Requires Node 24, like the root project. From this checkout, build the root package (`npm run build` at the root), then run `npm install` and `npm test` here. Copy `env.example` to `.env` and run `npm start`, then open http://127.0.0.1:3077. The note flow works without credentials. Bridge preparation needs `BRIDGE_CONFIG` pointing at the deployment configuration described in the root SDK documentation.

To use it outside this checkout, copy the folder and install the SDK tarball with `npm install /absolute/path/alphaton-midnight-ton-bridge-VERSION.tgz` (the tarball from the release bundle or `npm pack`), which replaces the checkout-relative dependency. Do not copy `.state` or keys.

Saving a note returns a SHA-256 commitment and its random opening; keep the opening to later prove which text the commitment binds. Notes are cleared on restart.

A production app must serve over HTTPS, authenticate users on its backend, connect a TON wallet with TON Connect, and send the prepared payload to the `sendTo` jetton wallet it returns, with the stated TON attached. The payload already encodes the escrow destination, amount and Midnight recipient; never send it directly to the escrow contract.
