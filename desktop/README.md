# MinaGuard Desktop

Electron wrapper around the MinaGuard Next.js UI + backend. Runs fully local:
SQLite DB in the user's app-data directory, lite-mode indexer, Auro signing
bridged through the user's browser. See
[`docs/desktop-audit-guide.md`](../docs/desktop-audit-guide.md) for the runtime
architecture and security notes.

## Prerequisites

- Bun 1.3+
- Node 20+
- Platform toolchain for `electron-builder` (macOS: Xcode CLT; Linux: build
  tools; Windows: Visual Studio Build Tools)
- Workspace deps installed at the repo root (`bun install`) so that `../ui`,
  `../backend`, and `../contracts` resolve

## Environment

`desktop/.env` (optional, git-ignored) is loaded at dev and build time via
`env $(grep -v '^#' .env | ...)`. The UI-build step reads it to inject
`NEXT_PUBLIC_*` vars into the bundle.

Recognized variables:

| Var | Where | Purpose |
|-----|-------|---------|
| `NEXT_PUBLIC_*` | UI build | Any vars read by `../ui` code at build time. |

Everything else the backend needs (`MINA_ENDPOINT`, `ARCHIVE_ENDPOINT`,
`DATABASE_URL`, `INDEXER_MODE`, `INDEX_START_HEIGHT`) is injected at runtime
by `backend-embed.ts` from the persisted user config — no env config needed
for those.

## Build pipeline (what each script does)

Run from `desktop/`.

| Script | Effect |
|--------|--------|
| `bun run prepare:backend` | Regenerates the SQLite Prisma client in `../backend/src/generated/prisma/` from `schema.sqlite.prisma`. Runs the schema-sync check against `schema.prisma` first. |
| `bun run prepare:schema-sql` | Regenerates `desktop/assets/schema.sql` via `prisma migrate diff`. This is what `backend-embed.ts` executes against a fresh SQLite DB on first launch. |
| `bun run prepare:assets` | Copies `assets/schema.sql` into `dist/assets/`. |
| `bun run build:ui` | Builds `../ui` in standalone mode with `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:5050` and `NEXT_PUBLIC_INDEXER_MODE=lite`. |
| `bun run stage` | Rebuilds `packaging-stage/backend-bundle.js` (esbuild) and copies `ui/.next/standalone` into `ui-standalone/`. |
| `bun run build:electron` | Compiles `src/*.ts` → `dist/*.js` and copies static files (preload, setup.html, auro/page.html). |
| `bun run build` | All of the above in order. |
| `bun run dev` | `build` + `electron --no-sandbox .` with `.env` applied. |
| `bun run package` | `build` + `electron-builder --dir` (outputs under `release/`). |

## Quick start (dev)

```bash
cd desktop
bun run dev
```

This rebuilds everything from source every run (fast enough; the UI build
dominates at ~15s). Launches Electron pointed at the freshly-staged artifacts.

## Schema changes

If `../backend/prisma/schema.prisma` changes:

1. Mirror the change into `../backend/prisma/schema.sqlite.prisma` (the
   `check-schema-sync.mjs` helper fails loudly if they drift).
2. `bun run dev` will auto-regen the SQLite client + `schema.sql`.

Existing user DBs are handled automatically: `backend-embed.ts` stamps
`PRAGMA user_version` with a hash of `schema.sql` at bootstrap, and on
mismatch deletes the DB and rebuilds it from chain. There are no incremental
migrations — a schema change costs a re-index, and manually subscribed vaults
must be re-added. To force a rebuild by hand:

- Linux:   `rm -f ~/.config/MinaGuard/minaguard.db`
- macOS:   `rm -f ~/Library/Application\ Support/MinaGuard/minaguard.db`
- Windows: `del %APPDATA%\MinaGuard\minaguard.db`

## Packaging a release

```bash
cd desktop
bun run package
```

Output lands in `desktop/release/<platform>-unpacked/`. Prisma's native query
engines for `darwin`, `darwin-arm64`, `windows`, `debian-openssl-3.0.x`
(Debian/Ubuntu) and `rhel-openssl-3.0.x` (Fedora/RHEL 9) are bundled — see
`binaryTargets` in the Prisma schemas — and pulled into
`packaging-stage/generated/prisma/` during `stage`. The two Linux engines let
one AppImage run on both Debian- and RHEL-family distros; without the matching
engine Prisma fails at runtime with "could not locate the Query Engine for
runtime …".

The `asarUnpack` list in `package.json` keeps the Prisma `.node` binaries
outside the asar archive so they can be executed at runtime.

## Distributable installers

`bun run package` produces an *unpacked* directory (good for local smoke
tests). To build actual installers, run:

```bash
cd desktop
bun run dist
```

This runs the full `build` and then `electron-builder --publish never`, using
the `build` block in `package.json`. Output lands in `desktop/release/`:

| Platform | Artifacts |
|----------|-----------|
| macOS    | `.dmg` + `.zip`, both `x64` and `arm64` |
| Linux    | `.AppImage` + `.deb` (`x64`) |
| Windows  | NSIS `.exe` installer (`x64`) |

`electron-builder` can only build macOS artifacts on macOS and (reliably)
Windows artifacts on Windows, so a single machine builds only its own
platform's installers. Cross-platform builds happen in CI (below).

The app icon is `build/icon.png` (1024×1024); electron-builder derives the
`.icns`/`.ico` from it. **It is a placeholder** — swap in the real brand icon
before a public release.

### Releasing via CI

`.github/workflows/desktop-release.yml` builds all three platforms on native
runners and uploads to a GitHub Release.

- **Cut a release:** push a tag matching `desktop-v*` (e.g. `desktop-v0.1.0`).
  Each runner builds its platform's installers and publishes them to a
  **draft** GitHub Release (configured via `publish.releaseType: "draft"` in
  `package.json`). Review the draft, then publish it manually.
- **Dry run:** trigger the workflow manually (`workflow_dispatch`) with no
  tag. It builds all three platforms and uploads the installers as CI
  artifacts (7-day retention) instead of publishing — use this to smoke-test
  the build before tagging.

The `owner`/`repo` in the `publish` block must match the GitHub repo the
release should land on.

### Signing (not done yet)

Released artifacts are **unsigned** (no Developer ID / Authenticode).
Consequences for users:

- **macOS:** the packed app is **ad-hoc signed** by the `afterPack` hook
  (`scripts/adhoc-sign.mjs`). Without it, electron-builder's repack breaks the
  bundle seal of Electron's shipped ad-hoc signature, and downloaded
  (quarantined) copies hit Gatekeeper's unbypassable **"MinaGuard is damaged
  and can't be opened"** — right-click → Open does not work in that state, and
  macOS 15 removed that bypass for unsigned apps anyway. With the hook, users
  instead get the recoverable "Apple could not verify…" prompt: approve once
  via System Settings → Privacy & Security → **Open Anyway**. For copies
  downloaded from a release built *without* the hook:
  `xattr -d com.apple.quarantine /Applications/MinaGuard.app`.
  Proper fix: an Apple Developer ID cert **and notarization**.
- **Windows:** SmartScreen shows an "unknown publisher" warning; users click
  **More info → Run anyway**. Proper fix: an Authenticode (ideally EV) cert.
- **Linux:** no signing needed.

The workflow explicitly disables identity signing
(`CSC_IDENTITY_AUTO_DISCOVERY=false`, `mac.identity: null`) so unsigned builds
succeed instead of failing while hunting for a certificate. To add signing
later, provide the certs as CI secrets and wire electron-builder's signing env
vars — the ad-hoc hook runs before electron-builder's sign step, so real
signatures simply overwrite it; no structural change to this pipeline is
required.

## Troubleshooting

**"The column `main.ContractConfig.X` does not exist"** — the bundled schema
is newer than the user's DB file. Current builds detect this via the
`user_version` stamp and rebuild automatically; seeing it means a build
predating the stamp — wipe the DB manually (paths under "Schema changes").

**"Prisma Client could not be found"** — the SQLite client wasn't regenerated.
Run `bun run prepare:backend`.

**Auro signing doesn't open a browser** — set `BROWSER` in `.env` to your
browser command (e.g. `BROWSER=google-chrome` or `BROWSER=firefox`) or leave
unset to use the OS default.
