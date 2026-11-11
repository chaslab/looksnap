const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ls', {
  on: (ch, cb) => ipcRenderer.on(ch, (_e, d) => cb(d)),
  send: (ch, d) => ipcRenderer.send(ch, d),
  invoke: (ch, d) => ipcRenderer.invoke(ch, d)
});
