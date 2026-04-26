import { fork, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { registerIpcHandlers } from './ipc.js';
import { registerConfigIpc } from './config-ipc.js';
import { handleAuroRoute } from './auro/router.js';
import { buildPickerScript } from './hid-picker.js';
import { startEmbeddedBackend, type EmbeddedBackendHandle } from './backend-embed.js';
import {
  deleteDatabase,
  fetchNetworkId,
  dbPath,
  readConfig,
  writeConfig,
  type UserConfig,
} from './config-store.js';

const PORT = 5050;
const NEXT_PORT = 5051;

// Defaults used only to pre-fill the first-run setup form. The app never runs
// against these silently — the user must confirm (or override) them on first
// launch, and the result is persisted to config.json.
const DEFAULT_MINA_ENDPOINT = 'https://api.minascan.io/node/mainnet/v1/graphql';
const DEFAULT_ARCHIVE_ENDPOINT = 'https://api.minascan.io/archive/mainnet/v1/graphql';

// All external resources (backend build output, UI build output) are
// pre-staged inside desktop/packaging-stage/ by the `stage` npm script —
// which runs for both dev and packaged builds. That keeps runtime paths
// identical across modes and lets electron-builder see everything inside
// its own appDir without cross-boundary file mappings.
const stageDir = join(import.meta.dirname, '..', 'packaging-stage');
const backendBundlePath = join(stageDir, 'backend-bundle.js');
const standaloneRoot = app.isPackaged
  ? join(process.resourcesPath, 'ui-standalone')
  : join(import.meta.dirname, '..', 'ui-standalone');
const nextServerEntry = join(standaloneRoot, 'ui', 'server.js');
const schemaSqlPath = join(import.meta.dirname, 'assets', 'schema.sql');
const setupHtmlPath = join(import.meta.dirname, 'assets', 'setup.html');
const preloadPath = join(import.meta.dirname, 'preload.js');
const setupPreloadPath = join(import.meta.dirname, 'preload-setup.js');

let backend: EmbeddedBackendHandle | null = null;
let nextChild: ChildProcess | null = null;
let currentConfig: UserConfig | null = null;

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

/** Runs the first-run setup flow. Resolves with the saved config and a
 *  `close()` callback the caller invokes after the main window is ready, or
 *  null if the user cancelled (in which case the window is already closed). */
function runFirstRunFlow(): Promise<{ config: UserConfig; close: () => void } | null> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 640,
      height: 560,
      resizable: false,
      title: 'MinaGuard Setup',
      webPreferences: { preload: setupPreloadPath },
    });

    let settled = false;
    const settle = (value: { config: UserConfig; close: () => void } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    firstRunResolvers = {
      save: async (cfg) => {
        const networkId = await fetchNetworkId(cfg.minaEndpoint);
        const full: UserConfig = { ...cfg, networkId };
        writeConfig(full);
        // Hide the setup window but keep it alive until the main window is
        // ready. Closing it here would briefly leave zero windows open,
        // tripping the `window-all-closed` → `app.quit()` handler while the
        // backend is still starting.
        win.hide();
        settle({
          config: full,
          close: () => {
            if (!win.isDestroyed()) win.destroy();
          },
        });
      },
      cancel: () => {
        settle(null);
        win.close();
      },
    };

    win.on('closed', () => {
      firstRunResolvers = null;
      settle(null);
    });

    void win.loadFile(setupHtmlPath);
  });
}

let firstRunResolvers: {
  save: (cfg: { minaEndpoint: string; archiveEndpoint: string }) => void;
  cancel: () => void;
} | null = null;

async function stopRunningServices(): Promise<void> {
  const handle = backend;
  backend = null;
  const child = nextChild;
  nextChild = null;
  try {
    if (handle) await handle.stop();
  } catch (err) {
    console.error('[desktop] backend shutdown failed', err);
  }
  if (child && !child.killed) child.kill();
}

async function changeEndpointsAndRelaunch(cfg: {
  minaEndpoint: string;
  archiveEndpoint: string;
}): Promise<void> {
  const networkId = await fetchNetworkId(cfg.minaEndpoint);
  const next: UserConfig = { ...cfg, networkId };
  writeConfig(next);
  await stopRunningServices();
  deleteDatabase();
  app.relaunch();
  app.exit(0);
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  registerConfigIpc({
    getConfig: () => currentConfig,
    getDefaults: () => ({
      minaEndpoint: DEFAULT_MINA_ENDPOINT,
      archiveEndpoint: DEFAULT_ARCHIVE_ENDPOINT,
    }),
    onFirstRunSave: async (cfg) => {
      firstRunResolvers?.save(cfg);
    },
    onFirstRunCancel: () => {
      firstRunResolvers?.cancel();
    },
    onChangeEndpoints: changeEndpointsAndRelaunch,
  });

  currentConfig = readConfig();
  let closeSetupWindow: (() => void) | null = null;
  if (!currentConfig) {
    const result = await runFirstRunFlow();
    if (!result) {
      app.quit();
      return;
    }
    currentConfig = result.config;
    closeSetupWindow = result.close;
  }

  backend = await startEmbeddedBackend({
    dbPath: dbPath(),
    minaEndpoint: currentConfig.minaEndpoint,
    archiveEndpoint: currentConfig.archiveEndpoint,
    schemaSqlPath,
    backendBundlePath,
  });

  await startHttpServer(backend);

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: preloadPath,
    },
  });

  // Keep setup window alive until the main window has a content to show, then
  // close it. `did-finish-load` fires after the initial navigation completes.
  if (closeSetupWindow) {
    const close = closeSetupWindow;
    win.webContents.once('did-finish-load', close);
    // Defensive: if the first navigation fails for any reason, still release
    // the setup window so the user isn't left staring at an empty shell.
    win.webContents.once('did-fail-load', close);
  }

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
  await stopRunningServices();
  app.quit();
});
