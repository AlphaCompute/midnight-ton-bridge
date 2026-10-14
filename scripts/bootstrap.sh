#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/toolchain.env
case "$(uname -s)-$(uname -m)" in
  # sha: compact installer archive; compiler: the compactc $COMPACT_VERSION artifact it downloads
  # (both from the official GitHub releases).
  Darwin-arm64) target=aarch64-apple-darwin; sha=2c2595682ec4f72b3652521f0d1c4124315b169c9e699aae23c1368689e1f750; platform=aarch64-darwin; compiler=57af9b0449aa96b2905ea3d7a175b6b42ab38d725612a9cb2d73eb4ef253cce2;;
  Darwin-x86_64) target=x86_64-apple-darwin; sha=cb708f57c66319e0536bf40d7b23d0ca6fe4e0a3bf8ab87dd9f69c07b95850a6; platform=x86_64-darwin; compiler=eebae2d04b1ec05fe07d06398e36d78e60cf4927ddbc0dae7d5f5ebb9ac6721c;;
  Linux-x86_64) target=x86_64-unknown-linux-musl; sha=da594f9edfe8d87312c0c500443702b5cfa9d7e17c43433b6ed6580a36278ac8; platform=x86_64-unknown-linux-musl; compiler=e291b4bab4d4e857707008f8b1c25c2b8e0c843f6c737d0ee6c0d9ac69a6bbfb;;
  Linux-aarch64) target=aarch64-unknown-linux-musl; sha=853180a16dc4115f4f794b1de0aae43573dcc65b6c75225c11520b0df203dd72; platform=aarch64-unknown-linux-musl; compiler=7c7e38581808779d2671687c3378017bcf2fb3111a192fd1253f3472012df549;;
  *) echo 'Unsupported platform' >&2; exit 1;;
esac
mkdir -p .tools
base="https://github.com/midnightntwrk/compact/releases/download/compact-v$COMPACT_TOOLCHAIN"
archive="compact-$target.tar.xz"
curl --fail --location "$base/$archive" --output ".tools/$archive"
# Checksums are pinned here: one fetched beside the archive cannot detect a replaced release.
(cd .tools && printf '%s  %s\n' "$sha" "$archive" | shasum -a 256 -c -)
tar -xJf ".tools/$archive" -C .tools
".tools/compact-$target/compact" --directory "$PWD/.tools/compact" update "$COMPACT_VERSION"
# The installer downloads the compiler itself; verify that artifact against its pinned release digest.
(cd ".tools/compact/versions/$COMPACT_VERSION/$platform" && printf '%s  %s\n' "$compiler" artifact.zip | shasum -a 256 -c -)
npm ci
npm run compile:midnight
npm run compile:ton
