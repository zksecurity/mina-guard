import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { ipcMain } from 'electron';

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

function openInChrome(url: string): void {
  const chrome =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'cmd' :
    'google-chrome';

  const args =
    process.platform === 'darwin' ? ['-a', 'Google Chrome', url] :
    process.platform === 'win32' ? ['/c', 'start', 'chrome', url] :
    [url];

  execFile(chrome, args, (err) => {
    if (err) console.error('[desktop] failed to open Chrome:', err.message);
  });
}

function handleAuroRequest(method: string, payload: unknown): Promise<unknown> {
  const id = randomUUID();
  const promise = createRequest(id, payload);

  openInChrome(`http://127.0.0.1:${PORT}/auro/${method}?id=${id}`);

  return promise;
}

export function registerIpcHandlers(): void {
  ipcMain.handle('auro:request-accounts', () => {
    return handleAuroRequest('requestAccounts', {});
  });

  ipcMain.handle('auro:sign-fields', (_event, params) => {
    return handleAuroRequest('signFields', params);
  });

  ipcMain.handle('auro:sign-message', (_event, params) => {
    return handleAuroRequest('signMessage', params);
  });

  ipcMain.handle('auro:send-transaction', (_event, params) => {
    return handleAuroRequest('sendTransaction', params);
  });
}
