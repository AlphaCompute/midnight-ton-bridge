# Read-only route monitoring

Build with `npm run build`, set `BRIDGE_NETWORK=preprod` and `BRIDGE_STATE_DIR`
to the deployed route, then run `npm run monitor`. It runs the accounting check
in a bounded subprocess, serializes checks, persists failure state atomically and
serves only loopback:

- `GET http://127.0.0.1:9095/healthz`: HTTP 200 only while a fresh check is settled;
  otherwise HTTP 503. Stale evidence never remains healthy indefinitely.
- `GET http://127.0.0.1:9095/metrics`: Prometheus gauges for health, consecutive
  failures and last check/success times. It contains no keys or signed bytes.

Default interval is 60 seconds after each completed check, timeout 45 seconds,
alert-state threshold three consecutive failures, and stale limit 180 seconds.
A single inconsistent check changes health to degraded immediately; subsequent
failures raise the alert state. State transitions are emitted as JSON on stdout.
The supplied Prometheus rules include unhealthy, unavailable and stale checks.
Wire them to the appointed operator's Alertmanager receiver; this code does not
send emails or messages, and no external alert destination has been configured.

`npm run monitor -- --once` performs one check and exits with an appropriate
status. `BRIDGE_MONITOR_DIR` holds the durable status file;
`BRIDGE_MONITOR_LOCK_DIR` can place the process lock in a separate runtime folder.
Run only one monitor per state directory/port. Graceful SIGTERM removes the lock.
After an abrupt manual process kill, inspect the lock's PID and verify no monitor
remains before removing a stale lock. The supplied systemd service uses a runtime
directory that systemd clears between service lifetimes, while durable status
remains under `/var/lib/bridge-monitor`.

## Linux installation

Templates are in `infrastructure/monitor`. Build the exact reviewed source under
`/opt/midnight-ton-bridge`, create the `bridge` service account and state paths,
review/copy the environment and systemd unit, then enable it through the operator's
normal service-management process. Verify the Node executable path and use Node
24. Configure Prometheus to load the supplied scrape and alert rule files.

The route check does not open a wallet or read wallet secrets. It needs public
route deployment JSON and read access to the **live** transaction journals and
SQLite WAL/SHM files. Do not substitute stale journal snapshots. Restrict seed,
committee, mnemonic, wallet-sync and LP-secret paths; the template masks known
secret filenames and should be adapted to the deployment's complete key layout.
Keep the monitor state directory writable and the bridge source read-only.

A healthy sample checks code/configuration pins, immutable Midnight authority,
backing versus circulation and unresolved journals. It is not proof that every
transfer was delivered, a load test, or an independent audit. Cross-chain samples
are not atomic; in-flight deposits and withdrawals can temporarily appear
unsettled. Investigate before acting. The monitor never signs, transfers, retries,
rebalances, pauses or upgrades a contract automatically.
