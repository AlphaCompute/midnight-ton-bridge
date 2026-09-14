# Notes starter

This is a minimal Node-backed web example for a TApp builder. It keeps note plaintext off chain and uses the bridge SDK to prepare an unsigned jetton deposit with a Midnight recipient. It is not the whistleblower application. It has no Telegram authentication, hosted storage, hidden fees, custodial wallet or automatic submission.

From this checkout, build the root package, then run `npm install` and `npm test` here. Copy `env.example` to `.env` and run `npm start`. Open http://127.0.0.1:3077. The default local-memory note flow works without credentials. Bridge preparation requires the deployment configuration described in the root SDK documentation.

For independent delivery, copy this folder and install the delivered SDK tarball with `npm install /absolute/path/alphaton-midnight-ton-bridge-0.1.0.tgz`; this replaces the checkout-relative dependency. Run `npm test` and `npm start` without access to the original author's checkout. Do not include `.state` or keys in the handover.

A production Telegram Mini App must add an HTTPS deployment, validate Telegram initialization data on its backend, connect a TON wallet using TON Connect, and pass the prepared message to the correct verified jetton wallet. The unsigned payload already includes the escrow destination, amount and Midnight recipient. Never send the token transfer payload directly to the escrow contract. Store real notes with authentication and encryption; this demonstration deliberately clears notes on restart.
