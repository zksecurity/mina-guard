# Deployment — Architecture & Security Notes

This document describes the in-repo **deployment assets** (`deploy/`) — the compose
stacks, Caddy routing, and deploy scripts that run the hosted MinaGuard demo box. It is
**context for auditors, not fund-safety surface**: by the non-custodial design, even
host-root compromise here cannot move vault funds
([`security-audit-guide.md`](./security-audit-guide.md)). Production operational security
(servers, firewalls, CI, secrets) lives in the private ops repo,
`mina-guard-ops/architecture.md`, shared with auditors on request.

The two application tiers deployed here are documented in
[`ui-audit-guide.md`](./ui-audit-guide.md) (frontend) and
[`backend-audit-guide.md`](./backend-audit-guide.md) (indexer + API).

---

## General overview

The deployment assets serve the prod-facing box, which hosts three coexisting patterns:

| Pattern | Path prefix | Compose project | Inner-Caddy host port | Chain |
|---|---|---|---|---|
| Main (localnet) | `/app/*` | `minaguard` | `10000` | Lightnet, in-stack |
| Mesa Trail | `/trail/*` | `minaguard-trail` | `10001` | Mesa Trail (mesa-mut), on a separate node-stack box |
| PR previews | `/preview/<PR>/*` | per-PR | `1000N` | Lightnet, per-preview (see `preview-env/`) |

All three share one routing model: a host-level **outer Caddy** exposes its admin API on
`localhost:2019`, and each deploy script dynamically adds/removes a path-prefixed reverse-proxy
route (`@id: app-main` / `trail-main`) pointing at that stack's **inner Caddy** on its per-project
host port. The outer route also sets `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: credentialless` — the cross-origin isolation o1js needs for
`SharedArrayBuffer` proof generation in the browser — and strips duplicates coming up from the
inner Caddy.

## Architecture

### Files

| File | Purpose |
|---|---|
| `deploy.sh` | `up`/`down` for the main localnet deploy: compose + outer-Caddy route for `/app/*` |
| `docker-compose.yml` | Main stack: lightnet (daemon + archive + account manager), postgres, backend, frontend, explorer, inner Caddy |
| `Caddyfile` | Inner-Caddy routes for the main stack (`/app/*`) |
| `deploy-trail.sh` | `up`/`down` for the Mesa Trail deploy: env checks, VK-hash sourcing, compose + outer-Caddy route for `/trail/*` |
| `docker-compose.trail.yml` | Trail app stack: postgres, backend (archive discovery), frontend, explorer, inner Caddy — node stack is remote |
| `Caddyfile.trail` | Inner-Caddy routes for the trail stack (`/trail/*`), including cross-host proxies to the node-stack box |
| `.env.example` | Template for `deploy/.env` (gitignored), sourced by `deploy-trail.sh` |

Both scripts expect to be run from the repo root.

### Main deployment (`/app/*`, lightnet)

```bash
./deploy/deploy.sh up     # build + force-recreate, add /app/* route
./deploy/deploy.sh down   # teardown, wipe volumes, remove route
```

- Runs a single-node **lightnet** in the stack (`o1labs/mina-local-network:mesa-latest-lightnet` — the Mesa binary is required because MinaGuard's state exceeds the legacy 8-slot cap) with `RUN_ARCHIVE_NODE=true`, exposing daemon GraphQL (8080), account manager (8181), and archive-node-api (8282) to the other services.
- `up` uses `--force-recreate`: every deploy starts a fresh chain, and the app DB is wiped on `down -v` because its indexed state mirrors the lightnet chain.
- URLs after deploy: `https://mina-nodes.duckdns.org/app/` (app), `/app/health`, `/app/graphql`, `/app/accounts/acquire-account`, `/app/explorer`.
- Auto-deployed on every push to `main` by `.github/workflows/deploy-lightnet.yml` (self-hosted runner on the box); `.github/workflows/reset.yml` runs the same `down` + `up` on a 3-day schedule so the stack self-heals from bloat/drift during quiet periods.

### Mesa Trail deployment (`/trail/*`, mesa-mut)

```bash
./deploy/deploy-trail.sh up
./deploy/deploy-trail.sh down   # wipes the app DB volume — see below
```

Unlike the main deploy, only the **application stack** (postgres, backend, frontend, explorer,
inner Caddy) runs on this box. The **node stack** — mina-daemon, mina-archive, archive-node-api —
runs on a separate box, reached at `$MESA_NODE_HOST`:

- `:3085` — daemon GraphQL
- `:8282` — archive-node-api
- `:5433` — archive postgres, read-only `minaguard_ro` role (used by the backend's `DISCOVERY_BACKEND=archive` mode, which discovers contract deploys beyond the daemon's ~290-block bestChain horizon)

### Configuration

`deploy-trail.sh` sources `deploy/.env` (gitignored; template in `.env.example`) and fails fast
unless these are set:

- `MESA_NODE_HOST` — address of the node-stack box
- `ARCHIVE_DB_PASSWORD` — password for `minaguard_ro` on the archive postgres

`MINAGUARD_VK_HASH` is deliberately **not** deploy-time config: it's a property of the contract
source, committed at `contracts/.vk-hash`, and read from there automatically (override by
exporting it). The backend indexer filters contract discovery by this hash for the target network.
`contracts/.vk-hash` contains two labeled entries (`testnet=` and `mainnet=`); the deploy scripts
pick the entry matching the target network. To regenerate after a contract change, run both:

```
bun run dev-helpers/cli.ts vk-hash compile
MINA_NETWORK_DOMAIN=mainnet bun run dev-helpers/cli.ts vk-hash compile
```

then update the two lines in `contracts/.vk-hash`.

- URLs after deploy: `https://mina-nodes.duckdns.org/trail/` (app), `/trail/health`, `/trail/graphql`, `/trail/archive`, `/trail/explorer`.
- Auto-deployed on every push to `main` by `.github/workflows/deploy-trail.yml`, which supplies `MESA_NODE_HOST` and `ARCHIVE_DB_PASSWORD` from repo secrets.

**Why `down` wipes the DB (`down -v`).** During active contract development the VK hash changes
with every circuit-touching merge, and discovery filters by VK hash — so previously-indexed
`Contract` rows point at addresses the new indexer would skip anyway. Wiping avoids dead rows and
wasted rescan cycles (the `archive_discovered_height` cursor would be a stale high-water mark too).
Once the contract stabilizes, drop the `-v` to get persistence across deploys.

---

## Threat model & assumptions

This tier is **outside the fund-safety TCB**. Its security notes are about the cross-host data
plane and the load-bearing network control, not about protecting vault funds.

### The load-bearing control is the edge firewall, not host `ufw`

The trail app stack reaches the node-stack box over **three plaintext HTTP/TCP hops on the public
internet** — daemon GraphQL (`:3085`), archive-node-api (`:8282`), and read-only archive postgres
(`:5433`). What restricts those ports to this server's IP is the node-stack box's provider edge
firewall (**Hetzner Cloud Firewall**), *not* host `ufw`:

> **Docker publishes ports through its own iptables chains, which bypass `ufw` entirely — a `ufw`
> rule looks right but enforces nothing.** Before first `up`, confirm the edge firewall allows
> inbound `3085`, `8282`, and `5433` from this server's IP only (setup details in the ops repo:
> `mina-guard-ops/architecture.md` §3).

This correction is reflected in the load-bearing comments across `deploy-trail.sh`,
`docker-compose.trail.yml`, `Caddyfile.trail`, and `.env.example`, which previously recommended
host `ufw` rules that enforced nothing. The `:5433` archive-postgres port was also previously
missing from that guidance — it now appears where the backend reaches the DB directly
(`deploy-trail.sh`, `.env.example`); the Caddy-facing comments legitimately list only `3085`/`8282`,
since Caddy never proxies the DB port.

### Cross-origin isolation is required and enforced twice

o1js proof generation in the browser needs `SharedArrayBuffer`, which requires cross-origin
isolation (`COOP: same-origin` + `COEP: credentialless`). The outer Caddy sets these headers (and
strips duplicates from the inner Caddy); the inner trail Caddy *also* sets them so direct hits
(e.g. local testing against the inner Caddy) still isolate. Losing these headers silently breaks
proving, not security — but it's an availability footgun worth knowing.

### Caddyfile notes

The inner Caddyfiles (`Caddyfile` for `/app/*`, `Caddyfile.trail` for `/trail/*`) are near-mirrors:

- **`/app/archive` and `/trail/archive` rewrite the upstream path to `/`** — archive-node-api serves GraphQL only at its root, so merely stripping the prefix would forward `/archive` and 404.
- GraphQL/archive routes answer `OPTIONS` preflights themselves and set permissive CORS headers, deleting any duplicates from upstream.
- The main stack's `/app/accounts/*` routes match only the two lightnet account-manager endpoints (`acquire-account`, `release-account`) so the frontend's own `/accounts/*` pages fall through to the Next.js catch-all.
- The trail inner Caddy also sets COOP/COEP headers itself (redundant behind the outer Caddy, necessary when hitting the inner Caddy directly).
- `/_next/static/*` is served without the no-cache header (content-hashed filenames); everything else under the frontend catch-all gets `Cache-Control: no-cache`.

---

## File tree

```
deploy/
├── deploy.sh                   # main localnet up/down + outer-Caddy /app/* route
├── docker-compose.yml          # main stack: in-stack lightnet + app services
├── Caddyfile                   # inner-Caddy routes for /app/*
├── deploy-trail.sh             # trail up/down: env checks, VK-hash sourcing, /trail/* route
├── docker-compose.trail.yml    # trail app stack (remote node stack via $MESA_NODE_HOST)
├── Caddyfile.trail             # inner-Caddy routes for /trail/* + cross-host node proxies
└── .env.example                # template for deploy/.env (gitignored): MESA_NODE_HOST, ARCHIVE_DB_PASSWORD
```

---

## Dependencies

- **Docker + Docker Compose** — the deployment substrate. Note the `ufw`-bypass behavior of
  Docker-published ports above: firewalling must happen at the provider edge.
- **Caddy** (outer + per-stack inner) — reverse proxy and the enforcement point for COOP/COEP
  cross-origin-isolation headers. The outer Caddy's admin API (`localhost:2019`) is how the deploy
  scripts add/remove path-prefixed routes.
- **The Mesa lightnet image** (`o1labs/mina-local-network:mesa-latest-lightnet`) — required over a
  stock lightnet because MinaGuard's 13 state fields exceed the legacy 8-slot cap.
