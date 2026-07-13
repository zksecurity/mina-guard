import { fork, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu } from 'electron';
import { registerIpcHandlers } from './ipc.js';
import { registerConfigIpc } from './config-ipc.js';
import { handleAuroRoute } from './auro/router.js';
import { buildPickerScript } from './hid-picker.js';
import { startEmbeddedBackend, type EmbeddedBackendHandle } from './backend-embed.js';
import {
  deleteDatabase,
  describeError,
  verifyEndpoints,
  dbPath,
  readConfig,
  writeConfig,
  type UserConfig,
} from './config-store.js';

const PORT = 5050;
const NEXT_PORT = 5051;

// Host-header allowlist: the single chokepoint for /auro/*, the API, and the
// Next proxy. Blocks DNS rebinding — a page rebound to 127.0.0.1 is
// same-origin (CORS can't help) but can't forge the Host the browser sends.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

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
const vkHashPath = join(import.meta.dirname, 'assets', '.vk-hash');
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

    let ready = false;
    nextChild.on('error', reject);
    nextChild.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[desktop] next standalone exited with code ${code}`);
      }
      // Dying before "Ready" would otherwise leave this promise pending
      // forever and the app hung with no window.
      if (!ready) {
        reject(new Error(`UI server exited with code ${code ?? 'null'} before becoming ready`));
      }
    });
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

  const server = createServer((req, res) => {
    if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
      res.writeHead(403).end();
      return;
    }
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
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`[desktop] server listening on http://127.0.0.1:${PORT}`);
      resolve();
    });
  });
}

/** Boots everything the main window needs: the embedded backend (which talks
 *  to the configured endpoints) and the local HTTP server serving the UI.
 *  Throws — with services possibly half-started — when the endpoints are
 *  unusable; callers recover via stopRunningServices() + the setup window. */
async function startServices(config: UserConfig): Promise<void> {
  backend = await startEmbeddedBackend({
    dbPath: dbPath(),
    minaEndpoint: config.minaEndpoint,
    archiveEndpoint: config.archiveEndpoint,
    schemaSqlPath,
    vkHashPath,
    backendBundlePath,
  });
  await startHttpServer(backend);
}

/** Runs the setup flow: on first run seeded with defaults, and as the recovery
 *  path — seeded with the saved endpoints plus the startup error — when the
 *  app failed to start. Saving verifies the endpoints, persists them, and
 *  starts the backend while the window is still up, so failures surface
 *  inline and the user can correct the endpoints and retry. Resolves with the
 *  running config and a `close()` callback the caller invokes after the main
 *  window is ready, or null if the user cancelled (in which case the window
 *  is already closed). */
function runSetupFlow(
  initial: { minaEndpoint: string; archiveEndpoint: string },
  startupError: string | null,
): Promise<{ config: UserConfig; close: () => void } | null> {
  setupState = {
    minaEndpoint: initial.minaEndpoint,
    archiveEndpoint: initial.archiveEndpoint,
    error: startupError,
  };
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

    setupResolvers = {
      save: async (cfg) => {
        // Reject unreachable endpoints before persisting anything: a bad URL
        // must never overwrite a working config or wipe the database.
        const networkId = await verifyEndpoints(cfg.minaEndpoint, cfg.archiveEndpoint);
        const full: UserConfig = { ...cfg, networkId };
        // Tear down whatever an earlier failed attempt left half-running
        // before touching the database or starting again.
        await stopRunningServices();
        const previous = readConfig();
        if (
          previous
          && (previous.minaEndpoint !== full.minaEndpoint
            || previous.archiveEndpoint !== full.archiveEndpoint)
        ) {
          // Same policy as the in-app settings flow: the local index is only
          // meaningful for the endpoints it was built against.
          deleteDatabase();
        }
        writeConfig(full);
        try {
          await startServices(full);
        } catch (err) {
          console.error('[desktop] startup failed', err);
          await stopRunningServices();
          throw new Error(`Startup failed: ${describeError(err)}`);
        }
        currentConfig = full;
        // Hide the setup window but keep it alive until the main window is
        // ready. Closing it here would briefly leave zero windows open,
        // tripping the `window-all-closed` → `app.quit()` handler.
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
      setupResolvers = null;
      settle(null);
    });

    void win.loadFile(setupHtmlPath);
  });
}

let setupState: {
  minaEndpoint: string;
  archiveEndpoint: string;
  error: string | null;
} | null = null;

let setupResolvers: {
  save: (cfg: { minaEndpoint: string; archiveEndpoint: string }) => Promise<void>;
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
  if (child && !child.killed) {
    // Wait (briefly) for the child to actually exit so an immediate in-process
    // restart doesn't race it for the UI port.
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  }
}

async function changeEndpointsAndRelaunch(cfg: {
  minaEndpoint: string;
  archiveEndpoint: string;
}): Promise<void> {
  // Reject unreachable endpoints before persisting anything: a bad URL must
  // never overwrite a working config or wipe the database. The rejection
  // propagates to the settings modal, which shows it inline.
  const networkId = await verifyEndpoints(cfg.minaEndpoint, cfg.archiveEndpoint);
  const next: UserConfig = { ...cfg, networkId };
  writeConfig(next);
  await stopRunningServices();
  deleteDatabase();
  app.relaunch();
  app.exit(0);
}

app.whenReady().then(async () => {
  // No app menu — the default File/Edit/View/Window/Help bar isn't needed.
  // Applies to every window (setup + main). On macOS this also removes the
  // in-window menu bar; the app's own top menu bar is left minimal.
  Menu.setApplicationMenu(null);

  registerIpcHandlers();
  registerConfigIpc({
    getConfig: () => currentConfig,
    getSetupState: () => setupState ?? {
      minaEndpoint: DEFAULT_MINA_ENDPOINT,
      archiveEndpoint: DEFAULT_ARCHIVE_ENDPOINT,
      error: null,
    },
    onSetupSave: (cfg) => {
      if (!setupResolvers) throw new Error('Setup is not in progress');
      return setupResolvers.save(cfg);
    },
    onSetupCancel: () => {
      setupResolvers?.cancel();
    },
    onChangeEndpoints: changeEndpointsAndRelaunch,
  });

  const savedConfig = readConfig();
  let closeSetupWindow: (() => void) | null = null;

  if (savedConfig) {
    currentConfig = savedConfig;
    try {
      await startServices(savedConfig);
    } catch (err) {
      // The saved config no longer works (endpoint down, moved, or persisted
      // with a typo). Instead of dying headless with an unhandled rejection,
      // reopen the setup window seeded with the saved values and the failure
      // so the endpoints can be fixed in-app.
      console.error('[desktop] startup with saved config failed', err);
      await stopRunningServices();
      const result = await runSetupFlow(savedConfig, `Startup failed: ${describeError(err)}`);
      if (!result) {
        app.quit();
        return;
      }
      closeSetupWindow = result.close;
    }
  } else {
    const result = await runSetupFlow(
      { minaEndpoint: DEFAULT_MINA_ENDPOINT, archiveEndpoint: DEFAULT_ARCHIVE_ENDPOINT },
      null,
    );
    if (!result) {
      app.quit();
      return;
    }
    closeSetupWindow = result.close;
  }

  // Services are up at this point — either started directly from the saved
  // config, or by the setup window's save flow.
  openMainWindow(closeSetupWindow);
}).catch((err) => {
  // Last-resort backstop for anything the setup-window recovery can't reach
  // (e.g. broken install). Without it a startup failure is an unhandled
  // rejection and the app hangs with no window at all.
  console.error('[desktop] fatal startup error', err);
  dialog.showErrorBox('MinaGuard failed to start', describeError(err));
  app.exit(1);
});

function openMainWindow(closeSetupWindow: (() => void) | null): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'MinaGuard',
    webPreferences: {
      preload: preloadPath,
    },
  });

  // The loaded page's <title> ("desktop", from Next.js) would otherwise
  // replace the window title on every navigation. Pin it to "MinaGuard".
  win.on('page-title-updated', (event) => {
    event.preventDefault();
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
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', async (event) => {
  if (!backend && !nextChild) return;
  event.preventDefault();
  await stopRunningServices();
  app.quit();
});
