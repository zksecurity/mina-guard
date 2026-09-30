#!/usr/bin/env bash
# Hash the tracked inputs that can affect the MinaGuard circuit compilation.
set -euo pipefail

root="${1:-$(git rev-parse --show-toplevel)}"

# Git index entries include file paths, blob IDs, and the o1js submodule commit.
# CI checks out a clean tree, so the index describes exactly what it compiles.
{
  printf 'minaguard-vk-inputs-v1\nbun-1.3.10\n'
  git -C "$root" ls-files --stage -z -- \
    contracts/src \
    ':(exclude)contracts/src/tests/**' \
    contracts/tsconfig.json \
    contracts/babel.config.cjs \
    contracts/package.json \
    package.json \
    bun.lock \
    dev-helpers/cli.ts \
    dev-helpers/tsconfig.json \
    dev-helpers/commands/vk-hash-compile.ts \
    contracts/scripts/vk-input-fingerprint.sh \
    .github/workflows/vk-hashes.yml \
    ui/deps/o1js
} | sha256sum | cut -d ' ' -f1
