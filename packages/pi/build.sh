#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "$0")" && pwd)"
output="${1:-$package_dir/../../target/pi-0.87.1.webc}"
mkdir -p "$package_dir/runtime" "$(dirname "$output")"
cp "$package_dir/package.json" "$package_dir/package-lock.json" "$package_dir/runtime/"
npm ci --prefix "$package_dir/runtime" --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund
npm ci --prefix "$package_dir/optimizer" --ignore-scripts --no-audit --no-fund
node "$package_dir/prepare.mjs"
wasmer package build "$package_dir" --out "$output.tmp"
mv "$output.tmp" "$output"
printf 'Built %s\n' "$output"
