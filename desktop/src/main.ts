import { fork, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { registerIpcHandlers } from './ipc.js';
import { handleAuroRoute } from './auro/router.js';
import { buildPickerScript } from './hid-picker.js';
import { startEmbeddedBackend, type EmbeddedBackendHandle } from './backend-embed.js';

const PORT = 5050;
const NEXT_PORT = 5051;

// Mainnet defaults; a future settings UI can override per user.
const DEFAULT_MINA_ENDPOINT = 'https://api.minascan.io/node/mainnet/v1/graphql';
const DEFAULT_ARCHIVE_ENDPOINT = 'https://api.minascan.io/archive/mainnet/v1/graphql';

// All external resources (backend build output, UI build output) are
// pre-staged inside desktop/packaging-stage/ by the `stage` npm script —
// which runs for both dev and packaged builds. That keeps runtime paths
// identical across modes and lets electron-builder see everything inside
// its own appDir without cross-boundary file mappings.
const stageDir = join(import.meta.dirname, '..', 'packaging-stage');
const backendBundlePath = join(stageDir, 'backend-bundle.js');
// Next `output: 'standalone'` with outputFileTracingRoot at the repo root
// produces standalone/<repo-basename>/<package-dir>/server.js. The standalone
// tree ships as a sibling of the asar (via electron-builder `extraResources`)
// because electron-builder's `files` pipeline strips nested `node_modules`
// directories — the traced runtime deps (next, react, …) would be lost if we
// routed the tree through `files`/asar.
const standaloneRoot = app.isPackaged
  ? join(process.resourcesPath, 'ui-standalone')
  : join(import.meta.dirname, '..', 'ui-standalone');
const nextServerEntry = join(standaloneRoot, 'mina-guard', 'ui', 'server.js');
const schemaSqlPath = join(import.meta.dirname, 'assets', 'schema.sql');

let backend: EmbeddedBackendHandle | null = null;
let nextChild: ChildProcess | null = null;

function startNextStandalone(): Promise<void> {
  return new Promise((resolve, reject) => {
    nextChild = fork(nextServerEntry, [], {
      cwd: standaloneRoot,
      env: {
        ...process.env,
        HOSTNAME: '127.0.0.1',
        PORT: String(NEXT_PORT),
      },
      silent: true,
    });

    nextChild.on('error', reject);
    nextChild.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[desktop] next standalone exited with code ${code}`);
      }
    });

    let ready = false;
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      process.stdout.write(`[next] ${text}`);
      if (!ready && text.includes('Ready')) {
        ready = true;
        resolve();
      }
    };
    nextChild.stdout?.on('data', onData);
    nextChild.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[next] ${chunk.toString()}`);
    });
  });
}

async function startHttpServer(
  backendHandle: EmbeddedBackendHandle,
): Promise<void> {
  await startNextStandalone();

  createServer((req, res) => {
    if (handleAuroRoute(req, res)) return;
    // Express app is itself a (req, res, next) handler. If no /api/* or /health
    // route matches, Express calls next() and we fall through to the Next
    // standalone server via the proxy below.
    backendHandle.middleware(req as never, res as never, () => {
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: NEXT_PORT,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', (err) => {
        console.error('[desktop] next proxy error', err);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
  }).listen(PORT, '127.0.0.1', () => {
    console.log(`[desktop] server listening on http://127.0.0.1:${PORT}`);
  });
}

app.whenReady().then(async () => {
  registerIpcHandlers();

  backend = await startEmbeddedBackend({
    dbPath: join(app.getPath('userData'), 'minaguard.db'),
    minaEndpoint: process.env.MINA_ENDPOINT ?? DEFAULT_MINA_ENDPOINT,
    archiveEndpoint: process.env.ARCHIVE_ENDPOINT ?? DEFAULT_ARCHIVE_ENDPOINT,
    schemaSqlPath,
    backendBundlePath,
  });

  await startHttpServer(backend);

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.js'),
    },
  });

  let selectedHidDevice: Electron.HIDDevice | null = null;

  win.webContents.session.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    selectedHidDevice = null;
    const script = buildPickerScript(details.deviceList);
    win.webContents.executeJavaScript(script).then((deviceId: string) => {
      if (deviceId) {
        selectedHidDevice = details.deviceList.find(d => d.deviceId === deviceId) ?? null;
      }
      callback(deviceId || undefined);
    }).catch(() => {
      callback();
    });
  });

  win.webContents.session.setPermissionCheckHandler(() => true);
  win.webContents.session.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'hid') {
      if (!selectedHidDevice) return false;
      const dev = details.device as { vendorId?: number; productId?: number };
      return dev.vendorId === selectedHidDevice.vendorId
        && dev.productId === selectedHidDevice.productId;
    }
    return true;
  });

  win.loadURL(`http://127.0.0.1:${PORT}`);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', async (event) => {
  if (!backend && !nextChild) return;
  event.preventDefault();
  const handle = backend;
  backend = null;
  const child = nextChild;
  nextChild = null;
  try {
    if (handle) await handle.stop();
  } catch (error) {
    console.error('[desktop] backend shutdown failed', error);
  }
  if (child && !child.killed) {
    child.kill();
  }
  app.quit();
});
