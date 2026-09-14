#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "$(uname -s)-$(uname -m)" in
 Darwin-arm64) platform=aarch64-darwin;; Darwin-x86_64) platform=x86_64-darwin;;
 Linux-x86_64) platform=x86_64-linux;; Linux-aarch64) platform=aarch64-linux;;
 *) echo 'Set COMPACTC for this platform' >&2; platform=unknown;;
esac
compiler="${COMPACTC:-$PWD/.tools/compact/versions/0.31.1/$platform/compactc}"
export RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-2}"
fingerprint="$(shasum -a 256 contracts/midnight/bridge.compact | cut -d ' ' -f 1)-$("$compiler" --version)"
if [[ ! -f build/midnight/.source-fingerprint ]] || [[ "$(cat build/midnight/.source-fingerprint)" != "$fingerprint" ]]; then
  "$compiler" --skip-zk contracts/midnight/bridge.compact build/midnight
  printf '%s' "$fingerprint" > build/midnight/.source-fingerprint
fi
if [[ "${1:-}" == "--proof" ]]; then
  mkdir -p build/midnight/keys
  "$(dirname "$compiler")/zkir" compile-many build/midnight/zkir build/midnight/keys
fi
