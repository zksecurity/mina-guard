#!/usr/bin/env bash
# read-vk-hash <network> — print the MinaGuard verification-key hash for
# <network> from contracts/.vk-hash.
#
# Single source of truth for parsing .vk-hash. The file is the keyed
# per-network format (testnet=… / mainnet=…); this selects one network's line
# and validates it is a bare decimal. Hand-rolling this parse in each caller is
# how a format change once collapsed both lines into a "testnet=…mainnet=…"
# garbage hash and baked it into an image — route every reader through here.
#
# Usage: read-vk-hash.sh <testnet|mainnet>
set -euo pipefail

net="${1:-}"
[ -n "$net" ] || { echo "usage: read-vk-hash.sh <testnet|mainnet>" >&2; exit 2; }

# .vk-hash lives one directory up from this script (contracts/.vk-hash); resolve
# relative to the script so callers can invoke it from any working directory.
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
vk_file="${here}/../.vk-hash"
[ -f "$vk_file" ] || { echo "read-vk-hash.sh: not found: $vk_file" >&2; exit 1; }

h="$(grep -E "^[[:space:]]*${net}=" "$vk_file" | head -1 | cut -d= -f2- | tr -d '[:space:]')"
case "$h" in
  ''|*[!0-9]*)
    echo "read-vk-hash.sh: no valid '${net}=' hash in ${vk_file} (got '${h}')" >&2
    exit 1 ;;
esac
printf '%s\n' "$h"
