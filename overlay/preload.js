const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  appClose: () => ipcRenderer.send('app-close'),
  appMinimize: () => ipcRenderer.send('app-minimize'),
  appMaximize: () => ipcRenderer.send('app-maximize')
});
