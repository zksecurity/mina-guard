# Incremental store checkpoints: local validation

Date: 2026-09-26. Implementation branch: `fix/incremental-event-rebuild`.
Base: PR #139 at `16fdd59f5d35016c0ecfdd57e08d9294ba59c80b` (itself stacked on #138).
This records local checks, not deployment or auditor retest status.

## Behavior and compatibility

- The worker persists public owner, approval and nullifier stores, resumes from later blocks, and verifies all roots against the Mina node. Corruption, stale cursors and reorgs cause one full replay; a second mismatch stops the operation.
- Cursor pagination advances by descending event ID, so initial sync cannot loop at the legacy 50,000-row offset cap. Offset clients remain supported.
- Offline request v2 replaces the target vault's full event history with a complete leaf snapshot. The CLI independently reconstructs its roots and compares them with the supplied account snapshot. It still accepts v1 full-event requests. Signed responses remain v1.
- Deploy the cursor-compatible backend first, distribute updated CLI binaries, then release the v2-exporting UI/desktop. No on-chain circuit, signed message, event layout or database schema changed.
- Initial sync still reads full history. Cold restore rehashes saved leaves; warm requests still copy/save existing stores. Child execution maps and child reservation configuration still use child history. Lifetime map growth is not bounded by this change. Off-chain pruning alone would contradict the on-chain roots.

## Completed checks

| Check | Result |
|---|---|
| `bun install --frozen-lockfile` | Passed; lockfile and submodule pointer unchanged |
| `bun run --filter contracts build` and `bun run --filter contracts typecheck` | Passed |
| `MINA_NETWORK_DOMAIN=testnet SKIP_PROOFS=1 bun run --filter contracts test --timeout 180000` | 207 passed, 3 skipped, 1 timeout under host resource pressure |
| From `contracts/`: `MINA_NETWORK_DOMAIN=testnet SKIP_PROOFS=1 bun test src/tests/child.test.ts --test-name-pattern 'rejects ENABLE_CHILD_MULTI_SIG with a filled slot 0' --timeout 180000` | The timed-out test passed in isolation (1 pass) |
| `bun run --filter e2e test:unit` | 6 passed: cursor paging, 50,501-event initial sync, failed/repeated/malformed pages, and v2 UI exports for all three actions |
| Backend `bun test src/tests/` against a newly initialized isolated local PostgreSQL database | 161 passed after the cursor change; includes offset and cursor route coverage. Test database server stopped afterward |
| `bun run --filter backend build` and `bun run --filter backend prisma:check-schema-sync` | Passed |
| From `offline-cli/`: `MINA_NETWORK_DOMAIN=testnet SKIP_PROOFS=1 bun test src/tests/ --timeout 300000` | 35 passed, including v2 propose/approve and legacy v1 coverage. The binary test's no-binary path was subsequently replaced by the separate compiled-binary check below |
| From `offline-cli/`: `bun build --compile --target=bun-linux-x64 src/index.ts --outfile dist/mina-guard-cli-linux-x64 --define 'process.versions.node=""'` | Passed |
| `MINA_NETWORK_DOMAIN=testnet SKIP_PROOFS=1 bun test offline-cli/src/tests/offline-cli-e2e.test.ts --test-name-pattern 'compiled binary works' --timeout 300000` | 1 passed with a v2 checkpoint bundle from an isolated directory |
| `bun run --filter ui build`, UI `bunx tsc --noEmit`, and `bun run --filter desktop build` | Passed. Desktop build was repeated after cursor changes and includes its production UI, SQLite backend and Electron builds |
| Chromium test of the actual bundled `idb-store-checkpoint.ts` module | Passed: persisted data survived page recreation; a different cache key returned no data |
| From `offline-cli/`: `env -u SKIP_PROOFS MINA_NETWORK_DOMAIN=testnet taskset -c 0,1 bun test src/tests/offline-cli-e2e.test.ts --test-name-pattern '^offline-cli e2e (propose\|approve)$' --timeout 600000` | 2 passed with real proofs for v2 propose and approve; the offline cache reused the verified testnet compilation |
| From `offline-cli/`: `MINA_NETWORK_DOMAIN=testnet SKIP_PROOFS=1 taskset -c 2,3 bun test src/tests/offline-cli-e2e.test.ts --test-name-pattern '^offline-cli e2e (propose\|approve\|execute transfer)$' --timeout 600000` | Final v2 propose → approve → execute flow: 3 passed |
| `bun run --filter e2e test --list` | Lists only the 16 browser transaction tests; the Bun unit directory is excluded from Playwright discovery |
| Fresh forced testnet and mainnet VK compilation | Both match their pinned hashes; see below |
| `git diff --check` | Passed |

The first default-timeout contract run timed out in setup and then cascaded into
transaction-context errors. The longer run above completed with one timeout,
which passed alone. These are not represented as an uninterrupted green suite.

## Verification keys

Two Bun forced-compilation attempts ended with exit 137 on this busy host,
including a retry limited to two prover workers. The successful testnet and mainnet checks
used Node with `--max-old-space-size=4096`, `setNumberOfWorkers(1)`, and
`MinaGuard.compile({ cache: Cache.FileSystem('./cache'), forceRecompile: true })`
on the built contracts (separate caches per network). Results were compared directly with `contracts/.vk-hash`:

- Testnet: `19825825449094922590368570335526172372460503461387954161208728203093758057176` — match.
- Mainnet: `1165146245228354101744761247915744768994867916330784226539960942999248171252` — match.

## Not run

- Full Lightnet/browser transaction E2E and the database-resetting Playwright UI suite were not run; no preview stack was operated.
- macOS/Windows CLI binaries and a physical two-machine offline handoff were not tested locally.
- Nothing was deployed or released during local validation.
