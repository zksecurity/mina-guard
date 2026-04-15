# MinaGuard Monorepo

MinaGuard is a multisig wallet zkApp for Mina built with o1js, plus a Next.js UI and an Express indexer API.

## Packages

- `contracts/` - MinaGuard smart contract, stores, and tests.
- `backend/` - Express + Prisma + PostgreSQL read API and chain indexer.
- `ui/` - Next.js app with Auro wallet integration and on-chain actions.

## Key Features

- Propose -> approve -> execute lifecycle using proposal hash keyed approvals.
- Transfer, add/remove owner, threshold change, and delegate execution support.
- Indexed read API for contracts, owners, proposals, approvals, and raw events.
- Deploy + setup UI flow with session-only zkApp private key usage.

## Development

### First-time setup

```bash
# Fetch submodule (fork of o1js, for now)
git submodule update --init

bun install

# Build contracts (required by backend and UI)
bun run --filter contracts build

# Set up the backend environment
cp backend/.env.example backend/.env

# Generate Prisma client
cd backend && bunx prisma generate && cd ..
```

Prior to testing with lightnet, accounts must have funds. To fund them, add the
public keys to `dev-helpers/.env` and run:
```bash
cd dev-helpers && bun run cli.ts lightnet-fund
```

**NOTE**: To test with a Ledger device, its public key (corresponding to the account index used) must be funded similarly. Only the public key is needed.

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
bun run test:e2e

# Against Mina devnet (requires funded accounts in e2e/.env.devnet)
NETWORK=devnet bun run test:e2e
```

## Build

```bash
bun run --filter contracts build
bun run --filter backend build
bun run --filter ui build
```

## PR Preview Environments

Each PR targeting `main` gets an isolated preview stack deployed to the Hetzner server via a self-hosted GitHub Actions runner. Preview URLs follow the pattern `https://mina-nodes.duckdns.org/preview/<PR_NUMBER>/`.

Each stack includes: lightnet, PostgreSQL, backend, frontend, block explorer, and a Caddy reverse proxy.

### Manual management

```bash
# From repo root
./preview-env/preview.sh up <PR_NUMBER>    # deploy
./preview-env/preview.sh down <PR_NUMBER>  # teardown
./preview-env/preview.sh list              # show active previews
```

### Local development with Docker

You can run the full stack locally without the server's Caddy:

```bash
PR_NUMBER=1 PREVIEW_PORT=10001 docker compose \
  -f preview-env/docker-compose.preview.yml \
  -f preview-env/docker-compose.local.yml \
  -p local up -d --build
```

Access at `https://localhost:10001/preview/1/`. In Auro Wallet, set the network URL to `https://localhost:10001/preview/1/graphql`.

Caddy serves this over HTTPS with a self-signed cert (`tls internal`) and sets the COOP/COEP headers o1js needs — accept the cert warning on first visit. The CA persists in the `caddy-local-data` volume so the cert stays stable across restarts.

```bash
# Logs
docker compose -p local logs -f            # all services
docker compose -p local logs -f frontend   # frontend only
docker compose -p local logs -f backend    # backend/indexer
docker compose -p local logs -f lightnet   # mina node + archive

# Tear down
docker compose -p local down -v
```

### Architecture

Requests hit the main Caddy (TLS + COOP/COEP headers) which reverse-proxies to a per-preview Caddy container that routes to individual services. COOP/COEP headers are set at the main Caddy level and upstream copies are stripped to prevent duplicates.

### Server setup

Preview routes are managed via the Caddy admin API (`localhost:2019`) — no sudo required. The self-hosted runner only needs Docker access (`docker` group).

### Gotchas

- **SharedArrayBuffer**: o1js WASM requires `crossOriginIsolated`, which needs COOP + COEP headers over HTTPS. Do not add `Cross-Origin-Resource-Policy: same-origin` — it blocks o1js blob URL sub-workers.
- **Bun workspaces**: `ui/deps/` must be copied into Dockerfiles because `mina-signer` is a `file:` dependency.
- **Minification disabled**: SWC/terser mangle BigInt ops used by o1js.
- **Server limits**: ~2GB RAM per preview stack, max 2–3 concurrent previews on the 30GB server. Run `docker image prune -f` periodically.
