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

### First-time setup

```bash
bun install

# Build contracts (required by backend and UI)
bun run --filter contracts build

# Set up the backend environment
cp backend/.env.example backend/.env

# Generate Prisma client
cd backend && bunx prisma generate && cd ..
```

### Running

```bash
# Run UI (from ui/ directory)
cd ui && bun run dev

# Run backend API/indexer (from backend/ directory)
cd backend && bun run dev

# Run contract tests
bun run --filter contracts test
```

## E2E Testing

Full end-to-end tests live in `e2e/` and exercise the deploy → propose → approve → execute lifecycle against a real Mina network. See [e2e/README.md](e2e/README.md) for setup details.

```bash
# Quick start with local lightnet (default)
cd e2e && bun install && bun test

# Against Mina devnet (requires funded accounts in e2e/.env.devnet)
cd e2e && NETWORK=devnet bun test
```

## Build

```bash
bun run --filter contracts build
bun run --filter backend build
bun run --filter ui build
```
