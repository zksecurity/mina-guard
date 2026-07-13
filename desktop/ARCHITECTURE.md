# Desktop App Architecture

Moved: the canonical, up-to-date architecture and security documentation for
the desktop app lives at [`docs/desktop-audit-guide.md`](../docs/desktop-audit-guide.md).

Quick orientation (see the full doc for diagrams and details):

- Electron **main process** runs everything: the embedded backend (Express API
  + lite indexer over SQLite, `src/backend-embed.ts`), a forked Next.js
  standalone child on `127.0.0.1:5051`, and a front HTTP server on
  `127.0.0.1:5050` that routes `/auro/*` (signing bridge) and `/api/*`
  (backend) and proxies the rest to the Next child.
- The **renderer** loads `http://127.0.0.1:5050`; `src/preload.js` injects a
  `window.mina` implementation bridged over IPC, plus the runtime endpoint
  config (`window.__minaGuardConfig`).
- **Auro signing** is forwarded to the real Auro extension in the user's
  browser: IPC → pending request map (`src/ipc.ts`) → external browser opens
  `/auro/<method>?id=…` (`src/auro/page.html`) → result POSTed back to
  `/auro/callback` (`src/auro/router.ts`).
- **Ledger** works in-window over WebHID (`select-hid-device` handler +
  `src/hid-picker.ts`).
- Node + archive **endpoints are user-configured** on first run (setup window,
  `src/config-store.ts`); changing them wipes the local SQLite index and
  relaunches.

Build pipeline and packaging are documented in [`README.md`](./README.md).
