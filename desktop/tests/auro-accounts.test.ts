import { describe, expect, it, mock } from 'bun:test';

const A = 'B62qkYgXmsk3R65YGNG41Zqu61hf9X1qBktDPzZkkthkSnukbXLPCAY';
const B = 'B62qoG5Yk4iVxpyczUrBNpwtx2xunhL48dydN53A2VjoRwF8NUjtL3';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
let auroAccounts: string[] = [];

// Bun shares one electron mock across test files, so every file's mock must
// export the same names (see config-store.test.ts).
mock.module('electron', () => ({
  app: { getPath: () => '/unused' },
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  // Stands in for the bridge page: Auro answers the request the main process opened.
  shell: {
    openExternal: async (url: string) => {
      ipc.resolveRequest(new URL(url).searchParams.get('id')!, auroAccounts);
    },
  },
}));
delete process.env.BROWSER;
const ipc = await import('../src/ipc.js');
ipc.registerIpcHandlers();

const fromAppWindow = { senderFrame: { url: 'http://127.0.0.1:5050/' } };
const invoke = (channel: string) => handlers.get(channel)!(fromAppWindow);

describe('connected Auro accounts', () => {
  it('reports the accounts from the latest connect', async () => {
    expect(await invoke('auro:get-accounts')).toEqual([]);

    auroAccounts = [A];
    expect(await invoke('auro:request-accounts')).toEqual([A]);
    expect(await invoke('auro:get-accounts')).toEqual([A]);

    auroAccounts = [B];
    await invoke('auro:request-accounts');
    expect(await invoke('auro:get-accounts')).toEqual([B]);
  });
});
