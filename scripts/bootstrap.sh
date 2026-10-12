#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=aarch64-apple-darwin; sha=2c2595682ec4f72b3652521f0d1c4124315b169c9e699aae23c1368689e1f750;;
  Darwin-x86_64) target=x86_64-apple-darwin; sha=cb708f57c66319e0536bf40d7b23d0ca6fe4e0a3bf8ab87dd9f69c07b95850a6;;
  Linux-x86_64) target=x86_64-unknown-linux-musl; sha=da594f9edfe8d87312c0c500443702b5cfa9d7e17c43433b6ed6580a36278ac8;;
  Linux-aarch64) target=aarch64-unknown-linux-musl; sha=853180a16dc4115f4f794b1de0aae43573dcc65b6c75225c11520b0df203dd72;;
  *) echo 'Unsupported platform' >&2; exit 1;;
esac
mkdir -p .tools
base="https://github.com/midnightntwrk/compact/releases/download/compact-v0.5.2"
archive="compact-$target.tar.xz"
curl --fail --location "$base/$archive" --output ".tools/$archive"
# Checksums are pinned here: one fetched beside the archive cannot detect a replaced release.
(cd .tools && printf '%s  %s\n' "$sha" "$archive" | shasum -a 256 -c -)
tar -xJf ".tools/$archive" -C .tools
".tools/compact-$target/compact" --directory "$PWD/.tools/compact" update 0.31.1
npm ci
npm run compile:midnight
npm run compile:ton
