# MinaGuard Backend

Proposal responses include `executionTxHash` from indexed execution records for confirmed explorer links. This is separate from the `lastExecuteTxHash` submission report, which marks an execution still in flight: the backend checks with the Mina node that it executes the proposal, but it may still fail.

Express API + polling indexer for MinaGuard contracts.

Moved: architecture, security notes, **and** operator docs (setup, scripts, env
vars, API routes, proposal-status derivation, Lightnet dev, troubleshooting)
now live in one place —
[`docs/backend-audit-guide.md`](../docs/backend-audit-guide.md).

Quick start:

```bash
cp backend/.env.example backend/.env    # create env file
bun install                              # from workspace root
bun run --filter backend dev             # dev mode (runs prisma:generate + prisma migrate deploy first)
```

See the [Operations section](../docs/backend-audit-guide.md#operations) for the
full environment-variable table, scripts, API-route reference, and
troubleshooting.

### Incremental event consumers

The checkpoint client uses the existing inclusive `fromBlock` / `toBlock` filters
and bounded offset pages. It rejects failed reads and ranges that exceed the
50,000-offset cap, rather than accepting partial history or requesting a repeated
page. Stable cursor pagination is tracked separately in
[issue #143](https://github.com/zksecurity/mina-guard/issues/143).

Reconstructed roots are checked against the Mina node; an event page is not
authenticated state. No backend API or database schema change is required for
incremental checkpoints.

### Proposal signing domains

Build this backend with the matching contracts package and network VK. Empty memos
now have a application-tagged, length-prefixed commitment and are verified like non-empty
memos; zero is no longer an absence sentinel. Database and event shapes are unchanged.
See the [memo lifecycle](../docs/backend-audit-guide.md#data-model) and
[breaking migration](../docs/offline-audit-guide.md#bundle-format-reference-requests-version-1-signed-responses-version-1).
