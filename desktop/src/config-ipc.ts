import { ipcMain } from 'electron';
import { assertMainWindow } from './ipc-security.js';
import type { UserConfig } from './config-store.js';

export interface ConfigIpcContext {
  /** Current effective config (non-null once the backend is running). */
  getConfig: () => UserConfig | null;
  /** Values to prefill the setup form with (defaults on first run, the saved
   *  config plus the startup error when recovering from a failed start). */
  getSetupState: () => { minaEndpoint: string; archiveEndpoint: string; error: string | null };
  /** Called when the setup window submits its form. Resolves once the backend
   *  is up on the new endpoints; rejects with a user-displayable error when
   *  validation or startup fails, so the window shows it inline and the user
   *  can correct the endpoints and retry. */
  onSetupSave: (cfg: { minaEndpoint: string; archiveEndpoint: string }) => Promise<void>;
  /** Called when the user closes the setup window without saving. */
  onSetupCancel: () => void;
  /** Called from Settings: persist new endpoints, wipe the DB, relaunch the app. */
  onChangeEndpoints: (cfg: { minaEndpoint: string; archiveEndpoint: string }) => Promise<void>;
}

/** Validates that `raw` is exactly `{minaEndpoint: string, archiveEndpoint: string}`
 *  with both values being http(s) URLs. The IPC handlers run in the main process
 *  and must not trust the renderer — the renderer-side validation in the modal
 *  and setup form is UX, not a security boundary. */
function parseEndpointsPayload(raw: unknown): { minaEndpoint: string; archiveEndpoint: string } {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid config payload: expected an object');
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(['minaEndpoint', 'archiveEndpoint']);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid config payload: unexpected field "${key}"`);
    }
  }
  const { minaEndpoint, archiveEndpoint } = obj;
  if (typeof minaEndpoint !== 'string') throw new Error('minaEndpoint must be a string');
  if (typeof archiveEndpoint !== 'string') throw new Error('archiveEndpoint must be a string');
  assertHttpUrl('minaEndpoint', minaEndpoint);
  assertHttpUrl('archiveEndpoint', archiveEndpoint);
  return { minaEndpoint, archiveEndpoint };
}

function assertHttpUrl(field: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${field} must use http or https`);
  }
}

export function registerConfigIpc(ctx: ConfigIpcContext): void {
  ipcMain.on('config:get-endpoints-sync', (event) => {
    event.returnValue = ctx.getConfig();
  });

  ipcMain.on('config:get-setup-state-sync', (event) => {
    event.returnValue = ctx.getSetupState();
  });

  ipcMain.handle('config:setup-save', async (_event, cfg) => {
    const parsed = parseEndpointsPayload(cfg);
    await ctx.onSetupSave(parsed);
  });

  ipcMain.handle('config:setup-cancel', () => {
    ctx.onSetupCancel();
  });

  ipcMain.handle('config:set-endpoints', async (event, cfg) => {
    assertMainWindow(event);
    const parsed = parseEndpointsPayload(cfg);
    await ctx.onChangeEndpoints(parsed);
  });
}
