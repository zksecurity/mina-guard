const { contextBridge, ipcRenderer } = require('electron');

const defaults = ipcRenderer.sendSync('config:get-defaults-sync');

contextBridge.exposeInMainWorld('setup', {
  getDefaults() {
    return defaults;
  },
  save(cfg) {
    return ipcRenderer.invoke('config:first-run-save', cfg);
  },
  cancel() {
    return ipcRenderer.invoke('config:first-run-cancel');
  },
});
