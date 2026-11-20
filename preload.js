const { contextBridge, ipcRenderer } = require('electron');

// Only the desktop app has window.desktop; the web UI checks for it to choose silent printing.
// getUrl/setUrl only answer the local setup page (checked in electron.js).
contextBridge.exposeInMainWorld('desktop', {
  print: (type, id, kot, printer) => ipcRenderer.invoke('print', type, id, kot, printer),
  printers: () => ipcRenderer.invoke('printers'),
  getUrl: () => ipcRenderer.invoke('get-url'),
  setUrl: url => ipcRenderer.invoke('set-url', url),
});
