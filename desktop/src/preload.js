const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();

contextBridge.exposeInMainWorld('mina', {
  requestAccounts() {
    return ipcRenderer.invoke('auro:request-accounts');
  },

  getAccounts() {
    console.log('[mina] getAccounts (stub)');
    return Promise.resolve([]);
  },

  requestNetwork() {
    console.log('[mina] requestNetwork (stub)');
    return Promise.resolve({ networkID: 'mina:testnet' });
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
