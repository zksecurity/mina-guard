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
  Update the `ui/deps/o1js` submodule pointer deliberately.

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
  verification-key hashes. Update `contracts/.vk-hash` when the circuit changes.
- Contract and protocol changes must be reflected in the UI worker, offline CLI,
  backend event decoding and types, desktop packaging, and applicable tests.
- Backend data-model changes must keep `backend/prisma/schema.prisma` and
  `backend/prisma/schema.sqlite.prisma` synchronized and include the appropriate
  migration. Run the schema-sync check.
- Remember that the desktop application packages the UI and a SQLite-backed
  backend; relevant UI, runtime-configuration, schema, and signing changes must
  be validated there as well.

## Documentation

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

- Run focused tests for every changed surface and add cross-surface or E2E tests
  when a shared protocol or user flow changes. Report exactly what ran and what
  was skipped.
- Circuit or proving changes require an appropriate real-proof test in addition
  to fast tests that use `SKIP_PROOFS`.
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

## Operations

- Do not deploy, publish releases, reset databases, stop shared containers,
  operate preview stacks, or mutate production infrastructure unless the user
  explicitly requests that action.
- Treat deployment state as time-sensitive. Inspect the relevant workflows,
  deployment scripts, and live controls before asserting what is active.
- Some development helpers intentionally stop colliding containers or reset
  local state. Read them first and confirm their scope before running them.
