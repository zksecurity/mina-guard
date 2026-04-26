const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();

// Synchronous IPC at preload time is intentional: the config is already loaded
// in the main process before the window opens, so this returns immediately and
// guarantees the values are available to any script in the renderer.
const initialConfig = ipcRenderer.sendSync('config:get-endpoints-sync');

contextBridge.exposeInMainWorld('__minaGuardConfig', initialConfig);

contextBridge.exposeInMainWorld('minaGuardConfig', {
  setEndpoints(cfg) {
    return ipcRenderer.invoke('config:set-endpoints', cfg);
  },
});

contextBridge.exposeInMainWorld('mina', {
  requestAccounts() {
    return ipcRenderer.invoke('auro:request-accounts');
  },

  getAccounts() {
    console.log('[mina] getAccounts (stub)');
    return Promise.resolve([]);
  },

  requestNetwork() {
    const id = initialConfig?.networkId ?? 'testnet';
    return Promise.resolve({ networkID: `mina:${id}` });
  },

  sendTransaction(params) {
    return ipcRenderer.invoke('auro:send-transaction', params);
  },

  signMessage(params) {
    return ipcRenderer.invoke('auro:sign-message', params);
  },

  signFields(params) {
    return ipcRenderer.invoke('auro:sign-fields', params);
  },

  on(event, handler) {
    console.log('[mina] on', event, '(stub)');
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
  },

  removeListener(event, handler) {
    console.log('[mina] removeListener', event, '(stub)');
    const set = listeners.get(event);
    if (set) set.delete(handler);
  },
});
