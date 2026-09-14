#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=aarch64-apple-darwin;;
  Darwin-x86_64) target=x86_64-apple-darwin;;
  Linux-x86_64) target=x86_64-unknown-linux-musl;;
  Linux-aarch64) target=aarch64-unknown-linux-musl;;
  *) echo 'Unsupported platform' >&2; exit 1;;
esac
mkdir -p .tools
base="https://github.com/midnightntwrk/compact/releases/download/compact-v0.5.2"
archive="compact-$target.tar.xz"
curl --fail --location "$base/$archive" --output ".tools/$archive"
curl --fail --location "$base/$archive.sha256" --output ".tools/$archive.sha256"
(cd .tools && shasum -a 256 -c "$archive.sha256")
tar -xJf ".tools/$archive" -C .tools
".tools/compact-$target/compact" --directory "$PWD/.tools/compact" update 0.31.1
npm ci
npm run compile:midnight
npm run compile:ton
