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

The events route supports inclusive `fromBlock` / `toBlock` filters and
`cursor=true` with an optional exclusive `beforeId`. Cursor pages order by
`id desc` and ignore offsets, so initial sync can pass the legacy 50,000-row
offset cap without repeating a page. Offset pagination remains compatible and
orders by descending block height, creation time, then event ID.

The checkpoint client requires the updated cursor API and rejects repeated or
non-decreasing IDs instead of looping against an older backend. Reconstructed
roots are checked against the Mina node; an event page is not authenticated
state. No database schema migration is required.
