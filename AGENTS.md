# Repository Instructions

These instructions apply to the entire MinaGuard monorepo.

## Repository workflow

- Use Bun for dependency management and workspace orchestration. Preserve `bun.lock`.
- Run checked-in scripts as written, including intentional uses of `node`, `npx`,
  `bunx`, or other runtimes. Do not mechanically replace them with Bun without
  verifying compatibility and updating CI where needed.
- Build contracts before packages that consume their output.
- Keep changes focused. Preserve unrelated tracked changes and untracked files;
  do not clean up or rewrite adjacent work without a task-related reason.
- Do not edit or commit generated build output, release binaries, compilation
  caches, or vendored/submodule contents unless the task explicitly requires it.
  Update the pinned `o1js` and `mina-signer` versions deliberately.

## Security and secrets

- Never expose private keys, tokens, passwords, or complete secret environment
  values. Do not commit `.env` files or place credentials in fixtures, logs,
  screenshots, bundles, or documentation.
- Treat frontend integrity and deceptive signing as security-critical. Contract
  safety alone does not make a compromised UI safe.
- Do not weaken fail-closed validation, signer confirmation, network-domain
  separation, proposal/contract binding, or key-isolation guarantees.
- `SKIP_PROOFS`, dummy proofs, and test keys are test-only mechanisms. They are
  not evidence that production proving or signing works.

## Online and offline signing

- Treat online and offline signing as one versioned protocol. The online UI
  exports a request bundle; the offline CLI independently summarizes, validates,
  builds, proves, and signs it; the online UI validates and broadcasts the signed
  response.
- Review every signing-related change across all affected surfaces, including
  `contracts/`, `ui/`, `offline-cli/`, `backend/`, `desktop/`, E2E tests, and
  release packaging. Do not ship one side of the online/offline flow without the
  corresponding updates to the other side.
- Keep transaction types, proposal construction and hashing, signed fields,
  network domains, memos, fees, nonces, validation, supported operations, and
  human-readable summaries synchronized across every relevant surface.
- Treat offline request and response JSON as a compatibility boundary. Preserve
  compatibility or deliberately bump the format version, update producers and
  consumers together, test rejection of incompatible files, and document the
  migration.
- Preserve the offline-signing invariants documented in
  `docs/offline-audit-guide.md`: private keys stay offline; the summary and human
  confirmation occur before signing; stdout remains pure signed-response JSON;
  network mismatches fail closed; and imported responses remain bound to the
  expected vault and proposal.

## Cross-package consistency

- Changes under `contracts/src/` or to o1js must verify both testnet and mainnet
  verification-key hashes. CI caches each domain's compiled hash by the circuit
  input fingerprint and recompiles on a cache miss. It publishes a fresh
  `contracts/.vk-hash` manifest for each commit; devnet uses the testnet hash.
  Do not commit a locally generated manifest. Release and deploy jobs must
  download the manifest for their exact source commit and verify it before use.
- Contract and protocol changes must be reflected in the UI worker, offline CLI,
  backend event decoding and types, desktop packaging, and applicable tests.
- Backend data-model changes must keep `backend/prisma/schema.prisma` and
  `backend/prisma/schema.sqlite.prisma` synchronized and include the appropriate
  migration. Run the schema-sync check.
- Remember that the desktop application packages the UI and a SQLite-backed
  backend; relevant UI, runtime-configuration, schema, and signing changes must
  be validated there as well.

## Documentation

- Write documentation and code comments in plain language. Start with what
  happens, when it happens, and why it matters. Name the concrete action or state
  that changes; add implementation details only when they help the reader
  understand the behavior or maintain the code. Avoid jargon and abstract
  comparisons when a direct explanation is enough. For example: "Add Owner and
  Create SubVault safety checks remain valid across polling refreshes unless
  the proposal or relevant Vault state changes."
- For every code change, review and update the relevant README files and
  `docs/*-audit-guide.md` files in the same change. Keep cross-referenced guides,
  especially `docs/ui-audit-guide.md` and `docs/offline-audit-guide.md`,
  synchronized.
- If reviewed documentation does not require an edit, state which guides were
  reviewed and why no update was needed in the final handoff.
- Treat implementation and tests as the source of truth. Revalidate live
  deployment, hosting, firewall, and CI-runner state before making current-state
  claims in documentation or reports.

## Validation

- Before an o1js compile or real-proof run, check available memory with
  `free -h` and running heavy jobs. Run heavy local validations serially;
  keep several GiB free for the OS and other worktrees. Limit the process
  memory or CPU when needed, and inspect the result before starting another.
  CI uses separate runners for mainnet and testnet compiles.
- Run focused tests for every changed surface and add cross-surface or E2E tests
  when a shared protocol or user flow changes. Report exactly what ran and what
  was skipped.
- Use the repository's canonical checks where applicable:
  - `bun run --filter contracts typecheck`
  - `bun run --filter contracts test`
  - `bun run --filter backend build`
  - `bun run --filter backend prisma:check-schema-sync`
  - `cd backend && bun test src/tests/`
  - `cd offline-cli && bun test`
  - `bun run --filter ui build`
  - `bun run test:ui`
  - `bun run test:e2e`

### Memory-safe validation

- Before starting a build, compilation, proof, or test suite, check `free -h`
  (especially `MemAvailable`) and the largest processes with
  `ps -eo pid,ppid,rss,comm --sort=-rss`. Budget against current available RAM,
  not total RAM; other worktrees and editor processes share this host.
- Run memory-heavy jobs sequentially. Do not overlap VK compilation, real-proof
  tests, contract/CLI lifecycle suites, Next.js builds or browser tests, and
  `bun build --compile`. Await process completion, including child processes,
  before starting the next job. Run network-specific VK checks one at a time.
- Limit o1js worker parallelism. On Linux, wrap the checked-in command with
  `taskset -c <two-allowed-CPUs>` (inspect `taskset -pc $$` first); o1js sizes its
  worker pool from available CPUs. A dedicated JS harness may instead call
  `setNumberOfWorkers(1)` before compilation. CPU limits alone are not RAM limits.
- For Bun-driven compilation/proving under a tight budget, use `bun --smol`
  to request more frequent garbage collection (for example,
  `bun --smol run dev-helpers/cli.ts vk-hash compile`). Keep the script itself
  unchanged; do not replace intentional Node invocations with Bun.
- If Bun still cannot fit, the VK helper supports Node 24's native TypeScript
  loading: `node --max-old-space-size=1536 dev-helpers/cli.ts vk-hash compile`.
  This lower-heap validation invocation still runs the helper's Bun contract
  rebuild and forced recompilation. It does not replace the repository's build
  scripts. The V8 heap limit does not bound WASM/native allocations, so retain
  the process-group memory cap below. The 1536 MiB heap is a VK-compilation
  setting, not a proven budget for lifecycle proofs. If a proof hits the V8
  heap limit, size its heap separately within the same total memory budget;
  distinguish a JavaScript heap failure from a cgroup or host OOM.
- On hosts with a user systemd manager, put each heavy job and its descendants
  in a transient scope with `MemoryHigh`, `MemoryMax`, and `MemorySwapMax=0`.
  For example, only when at least 10 GiB is currently available:
  `systemd-run --user --scope -p MemoryHigh=6800M -p MemoryMax=7G -p MemorySwapMax=0 taskset -c <two-allowed-CPUs> node --max-old-space-size=1536 dev-helpers/cli.ts vk-hash compile`
  (set `MINA_NETWORK_DOMAIN` for the target network). Choose limits that leave
  at least 3 GiB available for unrelated workloads; verify the scope properties
  and monitor `MemoryCurrent`/`MemoryPeak` and host `MemAvailable` during the run.
  Use an equivalent process-group memory limit where systemd is unavailable.
- If headroom is insufficient, defer the next heavy job. If a job is killed or
  times out under memory pressure, inspect its exit status and cgroup memory
  events before retrying; do not repeat the same unbounded concurrency or raise
  the cap beyond available headroom. A killed compile is not a verified VK, and
  skipped proofs are not a substitute for real-proof validation.
- Stop only task-owned processes whose identity has been checked. Do not kill
  unrelated editors, test processes, services, or containers to reclaim RAM.
  For file-watcher exhaustion during isolated Next.js tests, use
  `WATCHPACK_POLLING=1000` rather than changing host limits or stopping unrelated
  watchers.

## Operations

- Do not deploy, publish releases, reset databases, stop shared containers,
  operate preview stacks, or mutate production infrastructure unless the user
  explicitly requests that action.
- Treat deployment state as time-sensitive. Inspect the relevant workflows,
  deployment scripts, and live controls before asserting what is active.
- Some development helpers intentionally stop colliding containers or reset
  local state. Read them first and confirm their scope before running them.
