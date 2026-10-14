#!/usr/bin/env bash
# Installs the official Acton CLI into .tools/acton (the default ACTON_BINARY for npm run fund:ton).
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/toolchain.env
# Checksums are pinned here (from the GitHub release's recorded digests); a checksum fetched
# beside the archive cannot detect a replaced release.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) file=acton-aarch64-apple-darwin.tar.gz; sha=0db81ed9ec412d9370d8f0a8f2e4bbf9ff9980ff4f69039f20910a87c76dd900;;
  Darwin-x86_64) file=acton-x86_64-apple-darwin.tar.gz; sha=5605f7a134915eae9c5385c6bc0c57c5dba8de8c371d50bc6d3c714bf7801f0f;;
  Linux-x86_64) file=acton-x86_64-unknown-linux-gnu.tar.gz; sha=490d6763dcfe148e9c8346e3d56c398e950552d329a768b7e9168d4dd54afe3f;;
  Linux-aarch64) file=acton-aarch64-unknown-linux-gnu.tar.gz; sha=1af10f5f47bcf7e2317dd70f6926b8ba52f5b9e73481b030ac472920a4c581b2;;
  *) echo 'Unsupported platform' >&2; exit 1;;
esac
mkdir -p .tools/acton
curl --fail --location "https://github.com/ton-blockchain/acton/releases/download/v$ACTON_VERSION/$file" --output ".tools/$file"
(cd .tools && printf '%s  %s\n' "$sha" "$file" | shasum -a 256 -c -)
tar -xzf ".tools/$file" -C .tools/acton && rm ".tools/$file"
.tools/acton/acton --version
