# MinaGuard Backend

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
