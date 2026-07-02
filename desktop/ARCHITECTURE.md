# Desktop App Architecture

The desktop app wraps the existing MinaGuard Next.js UI inside Electron,
allowing users to run everything locally without depending on a hosted backend.

## Process Model

```
+------------------------+                  +----------------------+
| Electron BrowserWindow |                  | Chrome Tab           |
| (Renderer Process)     |                  | (auro/page.html)     |
|                        |                  |                      |
| Next.js UI loaded at   |                  | - calls real         |
| http://127.0.0.1:5050  |                  |   Auro extension     |
|                        |                  | - POSTs result       |
| preload.js injects     |                  |   to /auro/callback  |
| window.mina mock       |                  |                      |
+-----------+------------+                  +---^-----------+------+
            |                                   |           |
            | IPC                     opens     |       HTTP |
            v                         Chrome    |           |
+-------------------------------------------+  |           |
| Electron Main Process (Node.js)           |  |           |
|                                           |  |           |
|  +----------------------------+           |  |           |
|  | IPC Handlers (ipc.ts)      +-----------+  |           |
|  | - pending request map      |              |           |
|  | - createRequest / resolve  +<--------+    |           |
|  +----------------------------+         |    |           |
|                                         |    |           |
|  +------------------+ +----------------+----+--------+  |
|  | Next.js Server   | | Auro Router (router.ts)      +<-+
|  | (serves UI on    | |                              |
|  |  port 5050)      | | GET  /auro/:method           |
|  +------------------+ | GET  /auro/payload           |
|                        | POST /auro/callback         |
|                        +-----------------------------+
+-------------------------------------------+
```

## Auro Wallet Bridge

Since Electron doesn't have the Auro browser extension, signing requests
are forwarded to Chrome where the real extension lives.

```
1. UI calls window.mina.signFields(payload)
        |
        v
2. preload.js  -->  ipcRenderer.invoke('auro:sign-fields', payload)
        |
        v
3. Main process (ipc.ts)
   - generates request ID
   - stores payload + Promise in pending map
   - opens Chrome to /auro/signFields?id=xxx
        |
        v
4. Chrome loads /auro/signFields?id=xxx
   - page.html fetches payload from GET /auro/payload?id=xxx
   - calls requestAccounts() to connect
   - calls window.mina.signFields(payload)  <-- real Auro
   - user approves in Auro popup
        |
        v
5. Chrome page POSTs result to /auro/callback
   { id: "xxx", result: { data: [...], signature: "..." } }
        |
        v
6. Auro router receives POST
   - calls resolveRequest(id, result)
   - pending Promise resolves
        |
        v
7. ipcMain.handle returns result to renderer
        |
        v
8. preload.js returns result to UI
```

## Key Files

| File | Role |
|------|------|
| `src/main.ts` | Electron entry. Starts Next.js server, creates window, registers IPC. |
| `src/preload.js` | Injected into renderer. Exposes `window.mina` mock via contextBridge. |
| `src/ipc.ts` | IPC handlers + pending request map. Bridges preload and auro router. |
| `src/auro/router.ts` | HTTP routes under `/auro/*`. Serves signing page, receives callbacks. |
| `src/auro/page.html` | Chrome-facing page. Calls real Auro extension, posts result back. |

## Ports

| Port | Service |
|------|---------|
| 5050 | Next.js UI + Auro routes (single server) |
| 3001 | Backend API (run separately, or future embedded indexer) |
