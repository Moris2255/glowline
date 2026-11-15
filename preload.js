const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  spawn: (o) => ipcRenderer.invoke('pty:spawn', o),
  write: (id, d) => ipcRenderer.send('pty:write', id, d),
  resize: (id, c, r) => ipcRenderer.send('pty:resize', id, c, r),
  kill: (id) => ipcRenderer.send('pty:kill', id),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, id, d) => cb(id, d)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (_e, id, c) => cb(id, c)),
  onStat: (cb) => ipcRenderer.on('stat', (_e, s) => cb(s)),
  onVollbild: (cb) => ipcRenderer.on('vollbild', (_e, an) => cb(an)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  models: () => ipcRenderer.invoke('models:list'),
  loadModel: (id, laden) => ipcRenderer.invoke('models:load', id, laden),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (p) => ipcRenderer.invoke('config:set', p),
  pickDir: (s) => ipcRenderer.invoke('dir:pick', s),
  clipRead: () => ipcRenderer.invoke('clip:read'),
  clipWrite: (t) => ipcRenderer.send('clip:write', t),
  setTitle: (t) => ipcRenderer.send('win:title', t),
});
