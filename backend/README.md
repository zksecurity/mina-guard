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
bun run --filter backend dev             # dev mode (auto-runs prisma db push)
```

See the [Operations section](../docs/backend-audit-guide.md#operations) for the
full environment-variable table, scripts, API-route reference, and
troubleshooting.
