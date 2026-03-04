# MinaGuard Monorepo

MinaGuard is a multisig wallet zkApp for Mina built with o1js, plus a Next.js UI and an Express indexer API.

## Packages

- `contracts/` - MinaGuard smart contract, stores, and tests.
- `backend/` - Express + Prisma + SQLite read API and chain indexer.
- `ui/` - Next.js app with Auro wallet integration and on-chain actions.

## Key Features

- Propose -> approve -> execute lifecycle using proposal hash keyed approvals.
- Transfer, add/remove owner, threshold change, and delegate execution support.
- Indexed read API for contracts, owners, proposals, approvals, and raw events.
- Deploy + setup UI flow with session-only zkApp private key usage.

## Development

```bash
bun install

# Run UI
bun run --filter ui dev

# Run backend API/indexer
bun run --filter backend dev

# Run contract tests
bun run --filter contracts test
```

## Build

```bash
bun run --filter contracts build
bun run --filter backend build
bun run --filter ui build
```
