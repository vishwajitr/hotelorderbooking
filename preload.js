const { contextBridge, ipcRenderer } = require('electron');

// Only the desktop app has window.desktop; the web UI checks for it to choose silent printing.
contextBridge.exposeInMainWorld('desktop', {
  print: (type, id, kot, printer) => ipcRenderer.invoke('print', type, id, kot, printer),
  printers: () => ipcRenderer.invoke('printers'),
});
