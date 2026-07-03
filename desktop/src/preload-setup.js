const { contextBridge, ipcRenderer } = require('electron');

const state = ipcRenderer.sendSync('config:get-setup-state-sync');

contextBridge.exposeInMainWorld('setup', {
  getState() {
    return state;
  },
  save(cfg) {
    return ipcRenderer.invoke('config:setup-save', cfg);
  },
  cancel() {
    return ipcRenderer.invoke('config:setup-cancel');
  },
});
