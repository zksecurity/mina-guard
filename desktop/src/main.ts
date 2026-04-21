import { createServer } from 'node:http';
import { join } from 'node:path';
import { parse } from 'node:url';
import createNextServer from 'next/dist/server/next.js';
import { app, BrowserWindow } from 'electron';
import { registerIpcHandlers } from './ipc.js';
import { handleAuroRoute } from './auro/router.js';
import { buildPickerScript } from './hid-picker.js';
import { startEmbeddedBackend, type EmbeddedBackendHandle } from './backend-embed.js';

const PORT = 5050;
const uiDir = join(import.meta.dirname, '..', '..', 'ui');

// Mainnet defaults; a future settings UI can override per user.
const DEFAULT_MINA_ENDPOINT = 'https://api.minascan.io/node/mainnet/v1/graphql';
const DEFAULT_ARCHIVE_ENDPOINT = 'https://api.minascan.io/archive/mainnet/v1/graphql';

let backend: EmbeddedBackendHandle | null = null;

function resolveSchemaSqlPath(): string {
  // In dev, the schema lives at desktop/dist/assets/schema.sql relative to the
  // compiled main.js (import.meta.dirname points to dist/).
  // In a packaged build, electron-builder unpacks it to app.asar.unpacked/.
  return join(import.meta.dirname, 'assets', 'schema.sql');
}

async function startHttpServer(
  backendHandle: EmbeddedBackendHandle,
): Promise<void> {
  const nextApp = (createNextServer as unknown as typeof createNextServer.default)({ dir: uiDir, dev: false, port: PORT, hostname: '127.0.0.1' });
  const handle = nextApp.getRequestHandler();

  await nextApp.prepare();

  createServer((req, res) => {
    if (handleAuroRoute(req, res)) return;
    // Express app is itself a (req, res, next) handler. If no /api/* or /health
    // route matches, Express calls next() and we fall through to Next.js.
    backendHandle.middleware(req as never, res as never, () => {
      handle(req, res, parse(req.url!, true));
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
    schemaSqlPath: resolveSchemaSqlPath(),
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
  if (!backend) return;
  event.preventDefault();
  const handle = backend;
  backend = null;
  try {
    await handle.stop();
  } catch (error) {
    console.error('[desktop] backend shutdown failed', error);
  }
  app.quit();
});
