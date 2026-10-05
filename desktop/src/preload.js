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

// Electron prefixes an error thrown in the main process with
// "Error invoking remote method '<channel>': Error: ". Strip it so the UI shows
// the bridge's own message, such as Auro's reason for refusing.
function invokeAuro(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((err) => {
    const message = String(err?.message ?? err)
      .replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
    throw new Error(message);
  });
}

contextBridge.exposeInMainWorld('mina', {
  requestAccounts() {
    return invokeAuro('auro:request-accounts');
  },

  // Accounts from this session's last connect; the main process keeps them.
  getAccounts() {
    return invokeAuro('auro:get-accounts');
  },

  requestNetwork() {
    const id = initialConfig?.networkId ?? 'testnet';
    return Promise.resolve({ networkID: `mina:${id}` });
  },

  sendTransaction(params) {
    return invokeAuro('auro:send-transaction', params);
  },

  signMessage(params) {
    return invokeAuro('auro:sign-message', params);
  },

  signFields(params) {
    return invokeAuro('auro:sign-fields', params);
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
