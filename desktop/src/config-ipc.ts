import { ipcMain } from 'electron';
import type { UserConfig } from './config-store.js';

export interface ConfigIpcContext {
  /** Current effective config (must be non-null after first-run completes). */
  getConfig: () => UserConfig | null;
  /** Defaults to prefill the first-run form (mainnet endpoints). */
  getDefaults: () => { minaEndpoint: string; archiveEndpoint: string };
  /** Called when the setup window submits its form. */
  onFirstRunSave: (cfg: { minaEndpoint: string; archiveEndpoint: string }) => Promise<void>;
  /** Called when the user closes the setup window without saving. */
  onFirstRunCancel: () => void;
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

  ipcMain.on('config:get-defaults-sync', (event) => {
    event.returnValue = ctx.getDefaults();
  });

  ipcMain.handle('config:first-run-save', async (_event, cfg) => {
    const parsed = parseEndpointsPayload(cfg);
    await ctx.onFirstRunSave(parsed);
  });

  ipcMain.handle('config:first-run-cancel', () => {
    ctx.onFirstRunCancel();
  });

  ipcMain.handle('config:set-endpoints', async (_event, cfg) => {
    const parsed = parseEndpointsPayload(cfg);
    await ctx.onChangeEndpoints(parsed);
  });
}
