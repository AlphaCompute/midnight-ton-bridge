#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/toolchain.env
case "$(uname -s)-$(uname -m)" in
 Darwin-arm64) platform=aarch64-darwin;; Darwin-x86_64) platform=x86_64-darwin;;
 Linux-x86_64) platform=x86_64-unknown-linux-musl;; Linux-aarch64) platform=aarch64-unknown-linux-musl;;
 *) [[ -n "${COMPACTC:-}" ]] || { echo 'Set COMPACTC for this platform' >&2; exit 1; }; platform=unknown;;
esac
compiler="${COMPACTC:-$PWD/.tools/compact/versions/$COMPACT_VERSION/$platform/compactc}"
export RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-2}"
fingerprint="$(shasum -a 256 contracts/midnight/bridge.compact | cut -d ' ' -f 1)-$("$compiler" --version)"
if [[ ! -f build/midnight/.source-fingerprint ]] || [[ "$(cat build/midnight/.source-fingerprint)" != "$fingerprint" ]]; then
  "$compiler" --skip-zk contracts/midnight/bridge.compact build/midnight
  printf '%s' "$fingerprint" > build/midnight/.source-fingerprint
  # Keys from other source would prove the wrong circuits; never leave them beside new bindings.
  rm -rf build/midnight/keys
fi
if [[ "${1:-}" == "--proof" ]] && [[ "$(cat build/midnight/keys/.source-fingerprint 2>/dev/null)" != "$fingerprint" ]]; then
  rm -rf build/midnight/keys && mkdir -p build/midnight/keys
  "$(dirname "$compiler")/zkir" compile-many build/midnight/zkir build/midnight/keys
  printf '%s' "$fingerprint" > build/midnight/keys/.source-fingerprint
fi
