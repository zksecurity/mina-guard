import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { ipcMain, shell } from 'electron';
import { assertMainWindow } from './ipc-security.js';

const REQUEST_TIMEOUT_MS = 120_000;
const PORT = 5050;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: NodeJS.Timeout;
  payload: unknown;
}

const pending = new Map<string, PendingRequest>();

export function createRequest(id: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Auro request ${id} timed out`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timeout, payload });
  });
}

export function getPayload(id: string): unknown | undefined {
  return pending.get(id)?.payload;
}

export function resolveRequest(id: string, result: unknown): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  pending.delete(id);
  entry.resolve(result);
  return true;
}

export function rejectRequest(id: string, error: string): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  pending.delete(id);
  entry.reject(new Error(error));
  return true;
}

/**
 * Opens the Auro signing page in a browser. Uses the OS default browser via
 * shell.openExternal — on the assumption it's a Chromium-family browser with
 * the Auro extension. The served page shows a "copy this URL into a browser
 * with Auro" fallback so a user whose default lacks Auro can move it.
 *
 * The BROWSER env var forces a specific browser command instead (e.g.
 * BROWSER=google-chrome, =brave, =chromium). It only matters in dev — a
 * packaged end user has no way to set it — but it's a useful override there
 * and harmless in production.
 */
function openInBrowser(url: string): void {
  const browserOverride = process.env.BROWSER;
  if (browserOverride) {
    execFile(browserOverride, [url], (err) => {
      if (err) {
        console.error(`[desktop] failed to open BROWSER=${browserOverride}:`, err.message);
      }
    });
    return;
  }

  // Default browser, cross-platform.
  void shell.openExternal(url).catch((err) => {
    console.error('[desktop] failed to open default browser:', err.message);
  });
}

function handleAuroRequest(method: string, payload: unknown): Promise<unknown> {
  const id = randomUUID();
  const promise = createRequest(id, payload);

  openInBrowser(`http://127.0.0.1:${PORT}/auro/${method}?id=${id}`);

  return promise;
}

export function registerIpcHandlers(): void {
  ipcMain.handle('auro:request-accounts', (event) => {
    assertMainWindow(event);
    return handleAuroRequest('requestAccounts', {});
  });

  ipcMain.handle('auro:sign-fields', (event, params) => {
    assertMainWindow(event);
    return handleAuroRequest('signFields', params);
  });

  ipcMain.handle('auro:sign-message', (event, params) => {
    assertMainWindow(event);
    return handleAuroRequest('signMessage', params);
  });

  ipcMain.handle('auro:send-transaction', (event, params) => {
    assertMainWindow(event);
    return handleAuroRequest('sendTransaction', params);
  });
}
