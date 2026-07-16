# Desktop App (Electron) — Architecture & Security Notes

This document describes the **desktop app** (`desktop/`) — an Electron shell that
packages the same Next.js UI as the web app *plus* the backend indexer into a
single, self-contained, locally-running application.

It complements [`ui-audit-guide.md`](./ui-audit-guide.md): everything said there
about the UI (worker proving, signer boundary, memo handling, indexer trust)
applies unchanged inside the desktop shell, because the desktop app runs the
*same built UI*. This document covers only what the shell adds or changes. The
air-gapped path is documented in [`offline-audit-guide.md`](./offline-audit-guide.md).

---

## Why it exists

The online threat model ends with a dependency it can't remove: zkApp approvals
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
   (`POST /api/subscribe`) are indexed: "add existing account" backfills from
   block 0 via the archive endpoint, while the auto-subscribe right after a
   deploy starts a few blocks below the current height.
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
  in [`offline-audit-guide.md`](./offline-audit-guide.md).

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

`main.ts:390-413` wires the three handlers Electron needs for WebHID:

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
  `src/config-store.ts:93-115`): both must answer a real GraphQL POST within
  10 s. The network id is taken from the node's `networkID` field; only if the
  node doesn't expose one does a URL heuristic guess, defaulting to `mainnet`
  (`detectNetwork`, `119-130`). A node whose proof domain doesn't match this
  build's compile-time `BUILD_NETWORK_DOMAIN` (mainnet vs testnet, devnet
  sharing testnet) is rejected at save time — the bundled circuit can only
  prove against one domain.
- **Changing endpoints wipes the local DB and relaunches**
  (`changeEndpointsAndRelaunch`, `src/main.ts:277-291`): the local index is
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
  network (`backend-embed.ts:112-128`, devnet sharing the testnet circuit) and
  still accepts the pre-#93 single-bare-number format. When the file is
  missing, or a keyed file has no line for the configured network, the check
  no-ops rather than blocking startup or comparing against a wrong-network
  hash.
- **DB bootstrap & schema versioning:** when `minaguard.db` is missing — or
  stale — the bundled `assets/schema.sql` (generated from
  `schema.sqlite.prisma` via `prisma migrate diff`) is executed
  statement-by-statement with `$executeRawUnsafe`. Staleness is detected via
  `PRAGMA user_version`, stamped after a successful bootstrap with a 31-bit
  hash of schema.sql (`schemaVersionOf`/`readUserVersion`,
  `backend-embed.ts:15-38`): on mismatch the DB is deleted and rebuilt from
  chain (subscribed vaults must be re-added). The stamp is written last, so a
  boot that dies mid-schema leaves `user_version = 0` and rebuilds next run;
  a failed boot likewise deletes the partial DB.
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
whatever document the main window loads, and `main.ts` sets no `will-navigate`
handler or `setWindowOpenHandler`, so any document that loads there inherits
both.

**2. The loopback HTTP surface (`127.0.0.1:5050`).**
Reachable by every local process and, within limits, by web pages the user
visits. Its defenses: a Host-header allowlist (`main.ts:26`, checked first at
`100-103`) against DNS rebinding, no CORS headers anywhere (so no cross-origin
reads), and the UUIDv4 request id as the per-request token. Cross-origin
"simple" POSTs (`/auro/callback`, subscribe/unsubscribe) satisfy the
allowlist, and the id rides a URL handed to the OS browser
(`GET /auro/payload?id=`).

**3. Endpoint lifecycle & network-id detection (`src/config-store.ts`).**
Probing requires both endpoints to answer a GraphQL query. The detected network id
(node-reported, URL-heuristic fallback, `mainnet` default) must clear the
build's proof domain (`BUILD_NETWORK_DOMAIN`) to be persisted, and from there
feeds `requestNetwork`, the worker's `Mina.Network` id, the offline bundles'
`minaNetwork`, and `.vk-hash` line selection. Cross-network proposal replay
itself is blocked in-circuit (compile-time `NETWORK_DOMAIN` + per-network VK,
PR #93). Endpoint changes (with their DB wipe) are reachable only through the
settings-modal and setup-window IPC.

**4. Electron hardening posture (`src/main.ts`).**
The windows rely on modern Electron defaults (context isolation on, node
integration off, sandboxed renderers) rather than explicit settings, so the
posture tracks the pinned major (`electron ^43`, Dependabot-grouped).
Deliberate loosenings: `setPermissionCheckHandler(() => true)`,
`setDevicePermissionHandler` granting every non-HID device type, dev-only
`electron --no-sandbox`, and ad-hoc-only macOS signing
(`scripts/adhoc-sign.mjs`; see `desktop/README.md`).

**5. Packaged-content integrity.**
At runtime the app executes artifacts staged at build time: the backend
bundle, `schema.sql` (run through `$executeRawUnsafe`), `.vk-hash`, and
Prisma's native engines — the latter three `asarUnpack`ed as plain files under
the install's `resources/`. The producing pipeline is `scripts/stage.mjs` +
`scripts/bundle-backend.mjs` and `.github/workflows/desktop-release.yml`
(draft releases, unsigned artifacts).

**6. Network consistency across the Auro bridge.**
The desktop trusts `config.networkId`; the external browser's Auro has its own
selected network and node, and nothing reconciles the two — `requestNetwork`
is answered locally from config, while `sendTransaction` broadcasts through
Auro's node. The per-network VK and the fee-payer signature domain are what
constrain a mismatch.

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
│   │                        #   mode, VK-hash env, schema bootstrap + user_version
│   │                        #   stamp with delete-and-rebuild on mismatch)
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
   `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:5050`,
   `NEXT_PUBLIC_INDEXER_MODE=lite` and
   `NEXT_PUBLIC_MINA_NETWORK_DOMAIN=testnet` baked in (plus anything from the
   git-ignored `desktop/.env`). The network domain must match
   `BUILD_NETWORK_DOMAIN` in `config-store.ts` — the two flip together to cut
   a mainnet build.
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
