import { createServer } from 'node:http';
import { join } from 'node:path';
import { parse } from 'node:url';
import createNextServer from 'next/dist/server/next.js';
import { app, BrowserWindow } from 'electron';
import { registerIpcHandlers } from './ipc.js';
import { handleAuroRoute } from './auro/router.js';

const PORT = 5050;
const uiDir = join(import.meta.dirname, '..', '..', 'ui');

async function startNextServer(): Promise<void> {
  const nextApp = (createNextServer as unknown as typeof createNextServer.default)({ dir: uiDir, dev: false, port: PORT, hostname: '127.0.0.1' });
  const handle = nextApp.getRequestHandler();

  await nextApp.prepare();

  createServer((req, res) => {
    if (handleAuroRoute(req, res)) return;
    handle(req, res, parse(req.url!, true));
  }).listen(PORT, '127.0.0.1', () => {
    console.log(`[desktop] server listening on http://127.0.0.1:${PORT}`);
  });
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  await startNextServer();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.js'),
    },
  });

  win.webContents.session.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    if (details.deviceList.length > 0) {
      callback(details.deviceList[0].deviceId);
    } else {
      callback('');
    }
  });

  win.webContents.session.setPermissionCheckHandler(() => true);
  win.webContents.session.setDevicePermissionHandler(() => true);

  win.loadURL(`http://127.0.0.1:${PORT}`);
});

app.on('window-all-closed', () => {
  app.quit();
});
