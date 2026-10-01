#!/usr/bin/env bash
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

git -C "$fixture" init -q
mkdir -p "$fixture/contracts/src/tests" "$fixture/docs"
printf 'circuit\n' > "$fixture/contracts/src/MinaGuard.ts"
printf 'proof test\n' > "$fixture/contracts/src/tests/child.test.ts"
printf 'lockfile\n' > "$fixture/bun.lock"
git -C "$fixture" add .
original="$(bash "$here/vk-input-fingerprint.sh" "$fixture")"

printf 'documentation\n' > "$fixture/docs/guide.md"
git -C "$fixture" add .
[[ "$(bash "$here/vk-input-fingerprint.sh" "$fixture")" == "$original" ]]

printf 'changed circuit\n' > "$fixture/contracts/src/MinaGuard.ts"
git -C "$fixture" add .
changed="$(bash "$here/vk-input-fingerprint.sh" "$fixture")"
[[ "$changed" != "$original" ]]

printf 'changed proof test\n' > "$fixture/contracts/src/tests/child.test.ts"
git -C "$fixture" add .
proof_changed="$(bash "$here/vk-input-fingerprint.sh" "$fixture")"
[[ "$proof_changed" == "$changed" ]]

printf 'changed lockfile\n' > "$fixture/bun.lock"
git -C "$fixture" add .
lock_changed="$(bash "$here/vk-input-fingerprint.sh" "$fixture")"
[[ "$lock_changed" != "$proof_changed" ]]

printf 'compiler options\n' > "$fixture/contracts/tsconfig.json"
git -C "$fixture" add .
[[ "$(bash "$here/vk-input-fingerprint.sh" "$fixture")" != "$lock_changed" ]]

echo 'VK input fingerprint tests passed'
