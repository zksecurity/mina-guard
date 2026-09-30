#!/usr/bin/env bash
# Reject a VK artifact built from a different checkout or an incomplete domain set.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd -- "$here/../.." && pwd)"
source_file="$root/contracts/vk-source.sha"
manifest="$root/contracts/.vk-hash"

[[ -f "$source_file" && -f "$manifest" ]] || {
  echo 'VK manifest or source commit is missing' >&2
  exit 1
}
expected="$(git -C "$root" rev-parse HEAD)"
actual="$(cat "$source_file")"
[[ "$actual" == "$expected" ]] || {
  echo "VK manifest belongs to $actual, checkout is $expected" >&2
  exit 1
}

testnet="$($here/read-vk-hash.sh testnet)"
mainnet="$($here/read-vk-hash.sh mainnet)"
devnet="$($here/read-vk-hash.sh devnet)"
[[ "$testnet" == "$devnet" ]] || {
  echo 'Devnet and testnet VK hashes differ, but they share a circuit domain' >&2
  exit 1
}
[[ "$testnet" != "$mainnet" ]] || {
  echo 'Mainnet and testnet VK hashes unexpectedly match' >&2
  exit 1
}
