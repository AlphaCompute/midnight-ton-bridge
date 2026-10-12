# Reproducible private handoff

After committing the reviewed source and passing CI:

```sh
npm run build
node scripts/benchmarks.mjs
node scripts/prepare-handoff.mjs
```

`output/handoff` contains the committed source archive, SDK tarball, documentation,
public deployment evidence, checksums and a standalone notes starter with its SDK
vendored. The manifest records the source commit. Run these commands from a clean
checkout; do not distribute an archive from one revision alongside uncommitted
implementation changes. Local wallet state, keys and the commercial agreement
are excluded. Deliver privately through the approved Foundation channel.

On macOS, with `say`, `ffmpeg`, Python and Pillow installed:

```sh
BRIDGE_PYTHON=python3 node scripts/prepare-demo.mjs
```

This creates `output/demo/bridge-testnet-walkthrough.mp4` and `transcript.txt`.
It is an AI-narrated review of completed, independently verified testnet evidence,
not an attended live screen recording. Review and upload to the authorized Loom
account, or use the acceptance script to record an attended demonstration if
required. A local video is not a Loom link or acceptance.

The remaining authoritative inputs and signatures are listed in
[external release inputs](external-release-inputs.md). Do not replace them with
an internal checklist mark or an AI-generated approval.
