# Deployment — Architecture & Security Notes

This document describes the in-repo **deployment assets** (`deploy/`) — the compose
stacks, Caddy routing, and deploy scripts for the hosted MinaGuard demo box. The
frontend deployment is a fund-safety surface: an attacker who can serve altered
JavaScript can mislead owners into signing an unintended transaction. A host does
not hold owner private keys, but host compromise can still affect what owners see
and approve ([`security-audit-guide.md`](./security-audit-guide.md)). Operational security
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
| `docker-compose.trail.yml` | Trail app stack, **on-box build** (interim): postgres, backend (archive discovery), frontend, explorer, inner Caddy — node stack is remote |
| `docker-compose.trail.pull.yml` | Trail app stack, **pull-based**: same services, but app images are pulled from GHCR by attestation-verified digest instead of built on-box (see *Pull-based deploy*) |
| `Caddyfile.trail` | Inner-Caddy routes for the trail stack (`/trail/*`), including cross-host proxies to the node-stack box |
| `trail-pull-deploy.sh` | Box-side pull agent (phase 2): pulls the latest signed `/trail` images, verifies each build-provenance attestation with `gh attestation verify`, rolling-`up -d`s on digest change |
| `systemd/trail-pull-deploy.{service,timer}` | User-level systemd oneshot + 2-minute timer that drives `trail-pull-deploy.sh` |
| `validate-mainnet-build-config.py` | Rejects incomplete or visibly non-mainnet public URLs before the manual mainnet image build |
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
  Both workflows generate and verify the VK manifest for the checked-out commit
  before invoking `deploy.sh`; a missing or stale manifest stops the job before
  the stack is taken down.

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

`MINAGUARD_VK_HASH` is a property of the contract source. CI reuses compiled
testnet and mainnet hashes when their circuit-input fingerprint matches a
cached result. On a cache miss, it compiles both circuits in parallel. It
writes `contracts/.vk-hash` as a downloadable artifact and derives the
`devnet=` entry from testnet because both use `Field(2)`. Release and deploy
jobs download that manifest for the exact source commit and verify it before
selecting a hash. The backend uses the selected hash to filter contract
discovery. A local checkout can compile
either network with `MINA_NETWORK_DOMAIN=<network> bun run dev-helpers/cli.ts vk-hash compile`
for debugging; local results do not need to be committed.

- URLs after deploy: `https://mina-trail.duckdns.org/trail/` (app), `/trail/health`, `/trail/graphql`, `/trail/archive`, `/trail/explorer`. The frontend bundle bakes these `mina-trail.duckdns.org/trail` URLs (both the on-box `docker-compose.trail.yml` build args and the pull-based `trail-release.yml` build) — **not** `mina-nodes` (which serves `/app/*`).
- **Deploy is no longer push-triggered on this box.** During the three-box migration `.github/workflows/deploy-trail.yml` is `workflow_dispatch`-only: the trail box intentionally runs no self-hosted `deploy` runner, so a push-triggered on-box deploy would queue forever with no matching runner. It remains usable for a **manual interim redeploy** (it still supplies `MESA_NODE_HOST`/`ARCHIVE_DB_PASSWORD` from repo secrets and runs `deploy-trail.sh down && up`). `.github/workflows/trail-release.yml` instead **builds, pushes, and attests** the `/trail` GHCR images on pushes to `main` and deploys nothing. The intended phase-2 process pulls and verifies them on the box; check its live status below before relying on it.

**Why `down` wipes the DB (`down -v`).** During active contract development the VK hash changes
with every circuit-touching merge, and discovery filters by VK hash — so previously-indexed
`Contract` rows point at addresses the new indexer would skip anyway. Wiping avoids dead rows and
wasted rescan cycles (the `archive_discovered_height` cursor would be a stale high-water mark too).
Once the contract stabilizes, drop the `-v` to get persistence across deploys. **This wipe is
specific to the interim `deploy-trail.sh` path**; the pull-based deploy reverses it — in steady
production the VK is stable, so it does a rolling `up -d` with **no** volume wipe, wiping only when
a release deliberately changes the VK (see below).

### Pull-based deploy (`/trail`, GHCR pull + attestation verify)

Replacing the push-to-box `deploy` runner, the trail app is moving to a **pull** model in two
phases. Nothing pushes to the box; the box pulls — so no party with repo write access can execute
on it via a pushed-branch workflow.

- **Phase 1 — build & attest (CI, `.github/workflows/trail-release.yml`).** On every push to
  `main`, this workflow builds the three `/trail` images (backend, frontend, explorer), pushes them
  to GHCR by digest, and attaches a GitHub **build-provenance attestation** to each digest
  (`actions/attest-build-provenance` — keyless, Sigstore-backed: GitHub OIDC → Fulcio → Rekor). It
  touches the box for nothing. The frontend's `NEXT_PUBLIC_*` are baked here for
  **`mina-trail.duckdns.org/trail`** (kept in sync with `docker-compose.trail.yml`'s build args
  until the on-box build is retired).
- **Phase 2 — pull, verify & deploy (box, `deploy/trail-pull-deploy.sh`).** A **user-level systemd
  timer** (`deploy/systemd/trail-pull-deploy.{service,timer}`) fires every 2 minutes and runs the
  script, which — per image — pulls the `:main` tag, resolves its digest, and verifies that
  digest's attestation with `gh attestation verify` pinned to the release-workflow identity
  (`…/trail-release.yml@refs/heads/main`). **The ref pin is load-bearing:** a rogue build from
  another branch/workflow gets a different signer identity and fails the check. Verification is
  **fail-closed** — a verify failure never deploys. When (and only when) a digest actually changed,
  it runs a rolling `docker compose -f docker-compose.trail.pull.yml -p minaguard-trail up -d`
  against the attestation-verified digests, with **no** volume wipe (the interim `down -v` is
  reversed here; wipe only when a release deliberately changes the VK).

Both phase-2 files are marked **draft in this repository**. That label does not establish
what is active on a remote box. Log in as the deploy user and check the live timer,
unit contents, and recent runs before relying on pull-based deployment:

```bash
systemctl --user is-enabled trail-pull-deploy.timer
systemctl --user is-active trail-pull-deploy.timer
systemctl --user list-timers --all trail-pull-deploy.timer
systemctl --user cat trail-pull-deploy.service trail-pull-deploy.timer
journalctl --user -u trail-pull-deploy.service -n 50 --no-pager
docker ps --filter name=minaguard-trail --format '{{.Names}} {{.Image}}'
```

The timer should be enabled and active, recent runs should exit successfully
after verifying the image attestations, and the running app image references
should be pinned to `@sha256:` digests. A digest reference alone does not prove
the installed pull script verified it; inspect that script and its successful
journal entries. If the timer is absent or inactive, use the currently
authorized manual deploy procedure and verify the served release separately.

### AWS mainnet image build (preparation only)

`.github/workflows/mainnet-image-build.yml` is a **manual**, `main`-branch-only
build and attestation path for a future AWS deployment. It does not modify AWS,
start a service, or deploy a contract. It publishes backend and frontend images
under distinct `ghcr.io/zksecurity/mina-guard/mainnet-*` package names, tagged
with the source commit only, and uploads `mainnet-images-<sha>` with the exact OCI
digests. There is no mutable `:main` mainnet tag or mainnet explorer build. Mesa
Trail's push-triggered testnet release remains separate.

The shared backend and frontend Dockerfiles pin the multi-platform `oven/bun:1`
base image by OCI digest. Review and update that digest deliberately in both
Dockerfiles when upgrading Bun; the same files also build Trail and preview
images. The frontend's `apt-get` package resolution is still time-dependent.

Before dispatch, verify the GitHub `Production` environment has required
reviewers and prevent-self-review; merely naming the environment in YAML does
not enforce approval. A read-only GitHub API check on 2026-10-27 found a required
reviewer rule with prevent-self-review enabled, and none of the `MAINNET_*`
variables below configured yet. Recheck that live setting before release. Set
these **public build-time** environment variables on that environment to the
intended browser-reachable HTTPS services:

| Variable | Frontend use |
|---|---|
| `MAINNET_API_BASE_URL` | Indexer/API origin or base URL |
| `MAINNET_MINA_ENDPOINT` | Mina mainnet GraphQL endpoint |
| `MAINNET_ARCHIVE_ENDPOINT` | Mainnet archive GraphQL endpoint |
| `MAINNET_BLOCK_EXPLORER_URL` | Mainnet transaction/address links |

The workflow refuses missing, non-HTTPS, local, or visibly testnet/devnet/trail
URLs, URLs with credentials or query strings, and a nonempty base path. These
values are **baked into public JavaScript**; never put a secret or API token in
them. The `vk-hashes` job generates a manifest tied to the checked-out commit;
the release verifies that source SHA and selects the **mainnet** VK hash with
`read-vk-hash.sh mainnet`. The Docker builds receive both
`NEXT_PUBLIC_MINA_NETWORK=mainnet` and `MINA_NETWORK_DOMAIN=mainnet`, plus that
mainnet hash. The frontend production build checks their agreement. The backend
image records the same domain and hash; the AWS runtime must still explicitly
set `MINA_NETWORK_DOMAIN=mainnet` and compare its `MINAGUARD_VK_HASH` against the
release manifest.

Before serving a digest on AWS, the deployment verifier must check each OCI
attestation against this repository's `mainnet-image-build.yml@refs/heads/main`
workflow identity, use the digest from the release manifest, confirm the Mina
GraphQL endpoint actually reports mainnet, and check the browser-served release.
Those AWS deployment and independent served-content checks are not implemented
by this build workflow. A successful image build alone does not establish that
the frontend/backend are live or that mainnet account creation is ready.

---

## Threat model & assumptions

The cross-host data plane and edge firewall are load-bearing network controls.
Frontend integrity and release verification also matter because owners may sign
transactions based on content served from this tier.

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
- `/app/api/*` and `/trail/api/*` pass CORS to the backend. Its `CORS_ORIGINS` is unset in the compose files, so any origin may call the API from a browser. Set it to every origin that serves that stack's UI (check the outer Caddy: `deploy-trail.sh` prints `mina-nodes.duckdns.org/trail` while the trail UI is built for `mina-trail.duckdns.org`), or those pages lose the API.
- The main stack's `/app/accounts/*` routes match only the two lightnet account-manager endpoints (`acquire-account`, `release-account`) so the frontend's own `/accounts/*` pages fall through to the Next.js catch-all.
- The trail inner Caddy also sets COOP/COEP headers itself (redundant behind the outer Caddy, necessary when hitting the inner Caddy directly).
- `/_next/static/*` is served without the no-cache header (content-hashed filenames); everything else under the frontend catch-all gets `Cache-Control: no-cache`.

---

## File tree

```
deploy/
├── deploy.sh                       # main localnet up/down + outer-Caddy /app/* route
├── docker-compose.yml              # main stack: in-stack lightnet + app services
├── Caddyfile                       # inner-Caddy routes for /app/*
├── deploy-trail.sh                 # trail up/down (interim): env checks, VK-hash sourcing, /trail/* route
├── docker-compose.trail.yml        # trail app stack, on-box build (remote node stack via $MESA_NODE_HOST)
├── docker-compose.trail.pull.yml   # trail app stack, pull-based (GHCR images by verified digest)
├── Caddyfile.trail                 # inner-Caddy routes for /trail/* + cross-host node proxies
├── trail-pull-deploy.sh            # box-side pull agent: pull + attestation-verify + rolling up -d
├── validate-mainnet-build-config.py # CI check for explicit mainnet frontend build inputs
├── systemd/
│   ├── trail-pull-deploy.service   # user-level oneshot that runs trail-pull-deploy.sh
│   └── trail-pull-deploy.timer     # 2-minute timer driving the service
└── .env.example                    # template for deploy/.env (gitignored): MESA_NODE_HOST, ARCHIVE_DB_PASSWORD
```

The push-to-`main` CI workflow that feeds the pull path lives at
`.github/workflows/trail-release.yml` (build · push · attest); `deploy-trail.yml` is now
`workflow_dispatch`-only. The distinct manual AWS mainnet image build is in
`.github/workflows/mainnet-image-build.yml`.

---

## Dependencies

- **Docker + Docker Compose** — the deployment substrate. Note the `ufw`-bypass behavior of
  Docker-published ports above: firewalling must happen at the provider edge.
- **Caddy** (outer + per-stack inner) — reverse proxy and the enforcement point for COOP/COEP
  cross-origin-isolation headers. The outer Caddy's admin API (`localhost:2019`) is how the deploy
  scripts add/remove path-prefixed routes.
- **The Mesa lightnet image** (`o1labs/mina-local-network:mesa-latest-lightnet`) — required over a
  stock lightnet because MinaGuard's 13 state fields exceed the legacy 8-slot cap.
