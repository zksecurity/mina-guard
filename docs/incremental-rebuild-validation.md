# Incremental store checkpoints: local validation

Date: 2026-09-26. Implementation branch: `fix/incremental-event-rebuild`.
Original implementation base: PR #139 at
`16fdd59f5d35016c0ecfdd57e08d9294ba59c80b` (then stacked on #138).
After #138 and #139 merged, the two checkpoint commits were rebased onto `main`
at `2324013`. The new base has the same tree as the original base; the rebase
changed no implementation or test content.
On 2026-09-29, the branch was rebased onto `main` at `2c06349` after PR #141
added fail-closed network-domain selection. The conflict resolution preserves
those worker and CLI checks and validates the network before checkpoint export.
The producer tests now exercise the v2 checkpoint format with those checks.
This records local checks, not deployment or auditor retest status.

## Behavior and compatibility

- The worker persists public owner, approval and nullifier stores, resumes from later blocks, and verifies all roots against the Mina node. Corruption, stale checkpoints and reorgs cause one full replay; a second mismatch stops the operation.
- Cursor pagination was split into [issue #143](https://github.com/zksecurity/mina-guard/issues/143). The client uses the existing `fromBlock` filter and offset pages, rejects failed reads, and fails closed before requesting an offset above 50,000. Oversized initial or recovery ranges remain unsupported pending that issue.
- Offline request v2 replaces the target vault's full event history with a complete leaf snapshot. The CLI independently reconstructs its roots and compares them with the supplied account snapshot. It still accepts v1 full-event requests. Signed responses remain v1.
- Distribute updated CLI binaries, then release the v2-exporting UI/desktop. The backend API is unchanged. No on-chain circuit, signed message, event layout or database schema changed.
- Initial sync still reads full history. Cold restore rehashes saved leaves; warm requests still copy/save existing stores. Child execution maps and child reservation configuration still use child history. Lifetime map growth is not bounded by this change. Off-chain pruning alone would contradict the on-chain roots.

## Original checkpoint validation (2026-09-26)

The table below records the original commit, including cursor pagination that was
subsequently removed. It is historical evidence, not a claim that those cursor
checks cover the current offset client. Updated checks are recorded below.

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

## Cursor removal validation (2026-09-28)

- `bun run --filter e2e test:unit`: 5 passed, covering offset advancement with
  `fromBlock`, fail-closed handling at the offset cap, failed/malformed pages, and
  all three v2 offline bundle exports.
- Backend route code and route tests were restored to the PR #139 base; no
  cursor API or backend ordering change remains in this PR.
- `bun run --filter ui build` and `bun run --filter desktop build`: passed;
  desktop includes SQLite schema sync, the production UI and backend, and Electron.
- The original PR commit passed all six hosted CI checks, including browser E2E,
  VK hashes and macOS/Windows offline CLI checks. New CI is required for the
  cursor-removal commit.

## Network-domain merge resolution (2026-09-29)

- Contract build and typecheck passed with `MINA_NETWORK_DOMAIN=testnet`.
- Focused contract network-domain, checkpoint and event-rebuild tests: 27 passed.
- `bun run --filter ui test`: 14 passed, including all three v2 producers and
  rejection of unknown runtime networks before worker access or fetching.
- `bun run --filter e2e test:unit`: 5 passed; `bun run --filter desktop test`:
  7 passed.
- From `offline-cli/`: `MINA_NETWORK_DOMAIN=testnet SKIP_PROOFS=1 bun test
  src/tests/ --timeout 300000`: 36 passed, including the v2 transaction lifecycle,
  checkpoint tampering and legacy v1 requests. Proofs were disabled in this run.
- UI, backend and desktop builds passed. Backend and desktop SQLite schema-sync
  checks passed. The lockfile, o1js submodule and pinned VK file match `main`.
- Rebuilt the Linux offline CLI from the resolved source; its isolated-directory
  compiled-binary test passed with a v2 checkpoint request (1 passed).
- The UI and offline audit guides describe the combined network-validation and
  v2 snapshot behavior. The contracts guide now consistently describes nullifier
  serialization; the desktop guide calls the saved replay position a block height.
  The root, backend and desktop READMEs and backend/security guides were reviewed;
  their checkpoint and compatibility descriptions remain accurate without edits.

The original real-proof results above are historical; no new real-proof test was
run locally for this conflict resolution. Full browser/database suites,
macOS/Windows binaries and a physical two-machine handoff were not repeated.

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
