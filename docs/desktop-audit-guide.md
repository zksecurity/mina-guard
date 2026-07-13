# Desktop App (Electron) — Architecture & Security Notes

This document describes the **desktop app** (`desktop/`) — an Electron shell that
packages the same Next.js UI as the web app *plus* the backend indexer into a
single, self-contained, locally-running application.

It complements [`ui-audit-guide.md`](./ui-audit-guide.md): everything said there
about the UI (worker proving, signer boundary, memo handling, indexer trust)
applies unchanged inside the desktop shell, because the desktop app runs the
*same built UI*. This document covers only what the shell adds or changes. The
air-gapped path is documented in [`offline-signing.md`](./offline-signing.md).

---

## Why it exists

The online threat model ends with an uncomfortable dependency: zkApp approvals
are **blind signatures** over a single `Field`, so the user's safety rests
entirely on the integrity of the frontend that computed that field. A hosted
web frontend (and a hosted indexer) is a remote party that must be trusted at
every page load.

The desktop app removes that remote party. The UI is served from the local
install, the indexer runs in-process against a local SQLite file, and the only
remaining remote surfaces are:

- the **Mina node + archive endpoints** the user configures (data source for
  the local indexer and broadcast target), and
- the **Auro extension** in the user's own browser (for Auro signing).

The trust anchor is still the contract; the desktop app just shrinks who else
you have to trust from "the hosting operator, continuously" to "the installer
you obtained, once" (see the supply-chain notes below).

---

## General overview

On launch (`src/main.ts`):

1. **First run:** a setup window asks for a Mina GraphQL endpoint and an
   archive endpoint (pre-filled with minascan mainnet defaults — never used
   silently). Save probes both endpoints with a real GraphQL query, detects the
   network id from the node, and persists `config.json`. Unreachable endpoints
   are rejected before anything is persisted.
2. The **backend is booted in-process** (`src/backend-embed.ts`): the same
   `backend/` package (Express API router + indexer), esbuild-bundled at
   packaging time, running against **SQLite** (`minaguard.db` in the user-data
   dir) in **lite indexer mode**. Lite mode skips chain-wide contract
   discovery entirely — only vaults the UI explicitly subscribes
   (`POST /api/subscribe`, e.g. after a deploy or via "add existing account")
   are indexed, each backfilled from block 0 via the archive endpoint.
3. A **Next.js standalone server** (the pre-built `ui/` app) is forked as a
   child process on `127.0.0.1:5051`.
4. A **front HTTP server** on `127.0.0.1:5050` multiplexes everything:
   after a **Host-header allowlist check** (`127.0.0.1:5050`/`localhost:5050`,
   else 403 — the DNS-rebinding defense, see focus point 2), `/auro/*` → the
   Auro signing bridge; `/api/*` and `/health` → the embedded backend;
   everything else → reverse-proxied to the Next child.
5. The **main window** loads `http://127.0.0.1:5050` with a preload script
   that injects a `window.mina` implementation (backed by IPC, see below) and
   the runtime endpoint config (`window.__minaGuardConfig`, which
   `ui/lib/endpoints.ts` prefers over its build-time `NEXT_PUBLIC_*` values).

If startup with a saved config fails (endpoint moved, typo persisted), the
setup window reopens seeded with the saved values and the error, instead of the
app dying headless.

Signing inside the shell:

- **Auro** — Electron cannot host browser extensions, so `window.mina.*` calls
  are bridged to the real Auro extension in the user's normal browser (flow
  below).
- **Ledger** — works in-window over WebHID; Electron requires explicit
  device-selection and permission handlers, which `main.ts` provides.
- **Offline-CLI** — unchanged; the export/upload UI is the same one documented
  in [`offline-signing.md`](./offline-signing.md).

---

## Architecture

```
┌─────────────────────────── Electron main process ────────────────────────────┐
│                                                                               │
│  config-store.ts   config.json + minaguard.db (userData); endpoint probing    │
│  backend-embed.ts  embedded backend: Express API + lite indexer               │
│                    (Prisma → SQLite; bundle: packaging-stage/backend-bundle)  │
│  main.ts           front server 127.0.0.1:5050                                │
│                      Host allowlist   → 403 unless 127.0.0.1/localhost:5050   │
│                      /auro/*          → auro/router.ts  (signing bridge)      │
│                      /api/*, /health  → backend middleware                    │
│                      everything else  → proxy → Next standalone child :5051   │
│  ipc.ts            pending-request map (UUIDv4 ids, 120 s timeout)            │
│  config-ipc.ts     validated config IPC (setup save / change endpoints)       │
└────────▲──────────────────────────▲──────────────────────────────▲───────────┘
         │ IPC via contextBridge    │ HTTP (loopback)              │ GraphQL
┌────────┴───────────┐   ┌──────────┴──────────┐          ┌────────┴──────────┐
│ BrowserWindow      │   │ External browser    │          │ Mina node +       │
│ (renderer)         │   │ (OS default, has    │          │ archive node      │
│ Next.js UI +       │   │ the real Auro ext.) │          │ (user-configured  │
│ preload.js:        │   │ loads /auro/page,   │          │ endpoints)        │
│  window.mina       │   │ POSTs /auro/callback│          └───────────────────┘
│  __minaGuardConfig │   └─────────────────────┘
└────────────────────┘
```

| Port | Bound to    | Service                                              |
|------|-------------|------------------------------------------------------|
| 5050 | `127.0.0.1` | Front server: UI + backend API + `/auro/*` routes    |
| 5051 | `127.0.0.1` | Next.js standalone child (only reached via the proxy)|

The renderer still does all the heavy lifting the web UI does: the o1js worker
compiles, proves, and broadcasts directly to the configured Mina endpoint. The
embedded backend is exactly as (un)trusted as the hosted indexer in the online
model — the difference is who operates it.

---

## The Auro signing bridge

Electron has no extension support, so every `window.mina` call is forwarded to
the real Auro extension living in the user's normal browser:

```
1. UI calls window.mina.signFields(payload)          (renderer)
2. preload.js → ipcRenderer.invoke('auro:sign-fields', payload)
3. ipc.ts: generate UUIDv4 id, store {payload, promise} in the pending
   map (120 s timeout), open the OS browser at
   http://127.0.0.1:5050/auro/signFields?id=<uuid>
4. auro/page.html loads in the external browser:
   fetches GET /auro/payload?id=<uuid>, waits for the Auro provider,
   re-establishes the connection (requestAccounts), then calls the real
   window.mina.signFields(payload) — the user approves in the Auro popup
5. page POSTs {id, result} (or {id, error}) to /auro/callback
6. auro/router.ts resolves/rejects the pending promise for that id
7. ipcMain.handle returns the result to the renderer
8. preload.js returns it to the UI — which continues exactly as if a
   local extension had answered
```

Bridged methods: `requestAccounts`, `signFields`, `signMessage`,
`sendTransaction` (`src/ipc.ts:88-103`). Two are answered locally without ever
reaching Auro: `getAccounts` (stub, returns `[]`) and `requestNetwork`, which
returns `mina:<networkId>` **from the persisted desktop config**, not from
Auro (`src/preload.js:28-31`) — see focus point 6.

Deliberate design details worth knowing before auditing them:

- **Request ids are one-shot.** The first callback (success *or* error)
  resolves and deletes the pending entry. For that reason the page in a
  browser *without* Auro does **not** report an error — it stays silent and
  shows a copy-the-URL fallback, so the user can paste the URL into an
  Auro-capable browser whose callback lands on the still-live id
  (`src/auro/page.html:153-169`). An unanswered request times out after 120 s.
- **Browser selection:** `shell.openExternal` (OS default browser); a
  `BROWSER` env override exists for dev (`src/ipc.ts:62-75`).
- **Wallet identity comes from the external browser.** `requestAccounts`
  returns whatever account the user's Auro selects there; the desktop shell
  itself holds no keys of any kind.
- For `sendTransaction`, the broadcast is performed **by the external Auro**
  against *its* configured node — the desktop's Mina endpoint is not involved
  on that path (the Ledger and offline paths do use the configured endpoint).

## Ledger over WebHID

`main.ts:389-412` wires the three handlers Electron needs for WebHID:

- `select-hid-device` — intercepted; a picker overlay is injected into the page
  via `executeJavaScript` (`src/hid-picker.ts`) and the chosen `deviceId` is
  returned to Electron.
- `setDevicePermissionHandler` — grants HID access **only** to the exact
  vendorId/productId pair the user just picked; all non-HID device types are
  granted unconditionally.
- `setPermissionCheckHandler(() => true)` — blanket-approves *permission
  checks* (see focus point 4).

From there the UI's existing `ledgerWallet.ts` path (WebHID transport, blind
`signFields`, direct broadcast) runs unmodified.

---

## Configuration & persistence

Everything lives in Electron's per-user data dir
(`~/.config/MinaGuard` on Linux, `~/Library/Application Support/MinaGuard` on
macOS, `%APPDATA%\MinaGuard` on Windows):

| File           | Contents                                                     |
|----------------|--------------------------------------------------------------|
| `config.json`  | `{minaEndpoint, archiveEndpoint, networkId}` — no secrets    |
| `minaguard.db` | SQLite index (contracts, proposals, approvals, events)       |

- **Validation is main-process-side.** The setup form and the in-app settings
  modal validate for UX only; the IPC layer re-validates the payload shape
  strictly (exact two string fields, http/https URLs —
  `src/config-ipc.ts:25-54`) because the renderer is not trusted.
- **Endpoints are probed before persisting** (`verifyEndpoints`,
  `src/config-store.ts:78-97`): both must answer a real GraphQL POST within
  10 s. The network id is taken from the node's `networkID` field; only if the
  node doesn't expose one does a URL heuristic guess, defaulting to `mainnet`.
- **Changing endpoints wipes the local DB and relaunches**
  (`changeEndpointsAndRelaunch`, `src/main.ts:276-290`): the local index is
  only meaningful for the chain it was built against. The same policy applies
  in the setup-recovery flow. A failed save never overwrites a working config.
- Config writes are atomic (tmp file + rename); DB deletion also removes
  `-journal`/`-wal`/`-shm` sidecars.

## The embedded backend

`src/backend-embed.ts` boots the backend **inside the Electron main process**:

- The bundle (`packaging-stage/backend-bundle.js`) is produced at build time by
  `scripts/bundle-backend.mjs` from `backend/src/embed-entry.ts` — `contracts`
  is inlined; `@prisma/client`, `o1js`, `express`, `zod` and the
  generated Prisma client stay external and resolve from `desktop/node_modules`.
- Configuration is injected as env vars *before* the bundle is imported
  (`DATABASE_PROVIDER=sqlite`, `DATABASE_URL=file:<userData>/minaguard.db`,
  `INDEXER_MODE=lite`, `MINA_ENDPOINT`, `ARCHIVE_ENDPOINT`,
  `INDEX_START_HEIGHT=0`), because the backend's Prisma client reads
  `DATABASE_URL` at import time.
- `MINAGUARD_VK_HASH` is read from the bundled `contracts/.vk-hash`
  (`assets/.vk-hash`) so the `/api/subscribe` route can reject contracts whose
  on-chain verification key does not match this MinaGuard release (a
  *mismatched* VK is rejected on both the manual and auto-subscribe paths; a
  *missing* one is tolerated only while a just-deployed vault races indexing).
  The file carries one hash per network (`testnet=…` / `mainnet=…` lines —
  the circuit's compile-time `NETWORK_DOMAIN` makes each network's VK
  structurally distinct); the embed picks the line matching the configured
  network (`backend-embed.ts:71-87`, devnet sharing the testnet circuit) and
  still accepts the pre-#93 single-bare-number format. When the file is
  missing, or a keyed file has no line for the configured network, the check
  no-ops rather than blocking startup or comparing against a wrong-network
  hash.
- **Fresh-DB bootstrap:** when `minaguard.db` does not exist, the bundled
  `assets/schema.sql` (generated from `schema.sqlite.prisma` via
  `prisma migrate diff`) is executed statement-by-statement with
  `$executeRawUnsafe`. There is **no migration story** — schema changes require
  wiping the DB (documented in `desktop/README.md`). On a failed boot the
  partially-created DB is deleted so the next attempt bootstraps cleanly.
- The API router is mounted as middleware on the shared front server with **no
  CORS layer at all**: the API is same-origin for the app window, so no
  cross-origin grants are needed, and the cross-origin defense is the front
  server's Host-header allowlist — see focus point 2.

---

## Trust-model deltas vs the online UI

| Surface            | Online web UI                          | Desktop app                                             |
|--------------------|----------------------------------------|---------------------------------------------------------|
| Frontend integrity | Hosted origin, trusted per page load   | Local install — trust moves to the **installer** (once) |
| Indexer            | Hosted backend, remote operator        | Local process; **node/archive endpoints** feed it       |
| Auro signing       | In-page extension provider             | Loopback HTTP bridge → external browser's Auro          |
| Ledger signing     | WebHID in the tab                      | WebHID in the window (Electron handlers)                |
| Broadcast (non-Auro)| Frontend-baked endpoints              | User-configured endpoint (`window.__minaGuardConfig`)   |
| On-chain guarantees| Contract is the trust anchor           | Unchanged                                                |

What does *not* change: blind signing, the propose → approve → execute flow,
the worker/signer boundary, and the "indexer data is verified by the contract
on action paths, advisory on display paths" analysis from the UI guide — the
local indexer is fed by the configured archive/node endpoints, so a malicious
*endpoint* can lie to the desktop's display exactly like a malicious hosted
indexer could online.

#### Suggested focus points

**1. The renderer bridge × navigation policy (`src/preload.js`, `src/main.ts`).**
The preload exposes `window.mina` (signing triggers) and
`minaGuardConfig.setEndpoints` (endpoint rewrite + DB wipe + relaunch) to
*whatever document is loaded in the main window*, and `main.ts` sets no
`will-navigate` handler and no `setWindowOpenHandler`. Any non-local page that
ever loads in that window inherits the bridge — a phishing lever for Auro
prompts and a way to re-point the app at attacker-chosen endpoints ("speaks
GraphQL" is the only bar the endpoint probe sets).

**2. The loopback HTTP surface (`127.0.0.1:5050`).**
Reachable by every local process, and partially by web pages the user visits.
Two deliberate hardening choices shape it: the front server **rejects any
request whose `Host` header isn't `127.0.0.1:5050`/`localhost:5050` with 403**
(`main.ts:26`, checked first thing at `100-103`) — which kills DNS rebinding,
since a page rebound to 127.0.0.1 becomes same-origin (CORS can't help) but
cannot forge the Host the browser sends — and the server emits **no CORS
headers at all**, so browsers block cross-origin *reads* of every response
(`GET /auro/payload?id=` included). What remains: cross-origin **"simple"
POSTs** neither preflight nor need a readable response, and they carry the
*target's* Host, so they pass the allowlist — `/auro/callback` parses the body
as JSON regardless of Content-Type, and subscribe/unsubscribe are likewise
blind-POSTable (local index pollution as a nuisance vector). The only
authentication anywhere on this surface is therefore still the
*unguessability of the UUIDv4 request id*, and the id does travel: it rides a
URL handed to the OS browser (process argv under the `BROWSER` override,
history/sync, extensions that read tab URLs; local processes can read
responses too). What a known id buys is bounded — a forged `signFields`
result fails contract verification, a forged
`sendTransaction`/`requestAccounts` result corrupts pending-tx tracking or
spoofs the displayed identity, and a local (non-browser) caller can read the
pending payload off `GET /auro/payload?id=`.

**3. Endpoint lifecycle & network-id detection (`src/config-store.ts`).**
`verifyEndpoints` never persists unreachable endpoints, but a reachable-and-
malicious endpoint passes. Network-id detection falls back to URL substring
heuristics and **defaults to `mainnet`** when nothing matches; a wrong
`networkId` propagates into `requestNetwork`'s answer, the worker's
`Mina.Network` id (fee-payer signature domain), and the offline bundles'
`minaNetwork` field. (The proposal hash itself is no longer network-tagged at
the app level — since PR #93 cross-network replay is blocked by the
compile-time `NETWORK_DOMAIN` baked into the circuit and its per-network VK.)
The DB-wipe-on-change policy is reachable only through the settings-modal and
setup-window IPC (ties into focus 1).

**4. Electron hardening posture (`src/main.ts`).**
The windows rely on modern Electron defaults (context isolation on, node
integration off, sandboxed renderers) rather than explicit settings, so the
posture is only as strong as the defaults of the pinned major (`electron ^43`;
a Dependabot group bumps the Electron toolchain weekly so the pin can't
silently fall out of Electron's three-major support window).
Notable specifics: `setPermissionCheckHandler(() => true)` blanket-approves
permission *checks* for the local origin; `setDevicePermissionHandler` returns
`true` for every non-HID device type; the dev script runs
`electron --no-sandbox` (dev-only); released artifacts carry only an **ad-hoc**
macOS signature (`scripts/adhoc-sign.mjs` afterPack hook — without it,
downloaded quarantined copies fail Gatekeeper outright as "damaged"), so users
are still trained to click through Gatekeeper/SmartScreen prompts (see
`desktop/README.md`).

**5. Packaged-content integrity & the local supply chain.**
The app executes several artifacts staged at build time: the backend bundle,
`schema.sql` (run through `$executeRawUnsafe` on first launch), the `.vk-hash`
file, and Prisma's native `.node` engines. `schema.sql`, `.vk-hash` and the
engines are `asarUnpack`ed — plain files under the install's `resources/`
directory, modifiable by anything running as the user: equivalent in power to
replacing the app binary, but a quieter tamper target. The pipeline that
produces these artifacts is `scripts/stage.mjs` + `scripts/bundle-backend.mjs`
and the CI release workflow (`.github/workflows/desktop-release.yml`, draft
GitHub releases).

**6. Network consistency across the Auro bridge.**
The desktop believes `config.networkId`; the external browser's Auro has its
own selected network and node. `requestNetwork` is answered locally from
config, and `sendTransaction` executes in the external Auro against *its*
network — nothing reconciles the two. The fee-payer signature's network domain
and the per-network circuit (`NETWORK_DOMAIN` baked into the proposal hash and
the VK, PR #93) are what stand between a mismatch and a transaction landing on
an unintended chain.

---

## File tree

```
desktop/
├── src/
│   ├── main.ts              # Entry: boot order, setup-window flow, front server
│   │                        #   (5050), Next child (5051), main window, HID handlers
│   ├── ipc.ts               # auro:* IPC handlers + pending-request map (UUID ids,
│   │                        #   120 s timeout); opens the external browser
│   ├── preload.js           # Main window bridge: window.mina mock (→ IPC),
│   │                        #   window.__minaGuardConfig, minaGuardConfig.setEndpoints
│   ├── preload-setup.js     # Setup window bridge: getState/save/cancel
│   ├── config-ipc.ts        # Strict payload validation for all config IPC
│   ├── config-store.ts      # config.json read/write, endpoint probing, network-id
│   │                        #   detection, DB deletion
│   ├── backend-embed.ts     # Boots the bundled backend in-process (SQLite, lite
│   │                        #   mode, VK-hash env, fresh-DB schema bootstrap)
│   ├── hid-picker.ts        # In-page HID device picker (injected script)
│   ├── auro/
│   │   ├── router.ts        # /auro/* routes: payload fetch, signing page, callback
│   │   └── page.html        # Page the external browser loads; calls real Auro,
│   │                        #   POSTs the result back; copy-URL fallback
│   └── assets/setup.html    # First-run / recovery endpoint form
├── assets/
│   ├── schema.sql           # SQLite bootstrap DDL (generated via prisma migrate diff)
│   └── .vk-hash             # MinaGuard verification-key hashes, one per network
│   │                        #   (copy of contracts/.vk-hash); the configured
│   │                        #   network's line → MINAGUARD_VK_HASH
├── scripts/
│   ├── stage.mjs            # Stages the built UI + Prisma client into a fully
│   │                        #   link-free tree (bun symlink-store materialization)
│   └── bundle-backend.mjs   # esbuild: backend/src/embed-entry.ts → backend-bundle.js
├── packaging-stage/         # Build output: backend bundle + generated Prisma client
├── ui-standalone/           # Build output: staged Next standalone server + static
├── package.json             # Scripts + electron-builder config (targets, asarUnpack,
│                            #   unsigned mac identity, GitHub draft publish)
├── README.md                # Build pipeline, packaging, signing status, troubleshooting
└── ARCHITECTURE.md          # Pointer to this document
```

---

## Build & packaging pipeline

All steps run from `desktop/` (`bun run build` chains them; details in
`desktop/README.md`):

1. `prepare:backend` — regenerates the SQLite Prisma client from
   `schema.sqlite.prisma` (a schema-sync check fails loudly if it drifts from
   the Postgres `schema.prisma`).
2. `prepare:assets` — regenerates `assets/schema.sql` and copies it plus
   `contracts/.vk-hash` into `dist/assets/`.
3. `build:ui` — builds `../ui` in Next standalone mode with
   `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:5050` and
   `NEXT_PUBLIC_INDEXER_MODE=lite` baked in (plus anything from the
   git-ignored `desktop/.env`).
4. `stage` — `stage.mjs` copies the standalone tree into `ui-standalone/`
   resolving every bun-store symlink to a real file (Windows can't ship
   symlinks; naive dereferencing breaks Node module resolution — the script
   documents and verifies the fix, and hard-fails if any symlink survives),
   then `bundle-backend.mjs` produces `packaging-stage/backend-bundle.js`.
5. `build:electron` — `tsc` for `src/*.ts` + static file copies into `dist/`.
6. `package` / `dist` — `electron-builder` (`--dir` for an unpacked smoke-test
   build, or installers: dmg/zip for macOS x64+arm64, AppImage/deb for Linux,
   NSIS for Windows). Prisma query engines for darwin (x64/arm64), windows,
   debian- and rhel-flavored Linux are bundled and `asarUnpack`ed together
   with `dist/assets/**`.
7. CI: `.github/workflows/desktop-release.yml` builds all three platforms on
   native runners for `desktop-v*` tags and uploads to a **draft** GitHub
   release; artifacts are **unsigned** on every platform (macOS bundles get an
   ad-hoc signature from the `afterPack` hook so downloaded copies remain
   launchable).

## Dependencies

Runtime (`desktop/package.json`):

- **`electron` (^43)** — shell. Renderer isolation relies on its defaults (see
  focus point 4); a Dependabot group keeps the Electron toolchain
  (`electron` + `electron-builder` + the squirrel peer) bumped together.
- **`@prisma/client` (6.12.0)** — SQLite access for the embedded backend;
  native query engines ship per-platform and are `asarUnpack`ed.
- **`express`, `zod`** — the embedded backend's HTTP layer; kept
  external to the esbuild bundle so exactly one instance of each exists.
  (No `cors` dependency: the embedded API deliberately serves no CORS
  headers — see focus point 2.)
- **`o1js` (3.0.0-mesa.final)** — imported by the backend bundle at runtime
  (event decoding); same pin as the repo root.

Build-time: `electron-builder`, `esbuild`, `typescript`, `next` (types/build
only — the runtime Next server ships inside the staged standalone tree).

Everything the UI itself depends on (o1js worker, mina-signer submodule build,
Ledger/Auro libraries) is inherited from `ui/` at `build:ui` time — audit those
via [`ui-audit-guide.md`](./ui-audit-guide.md).
