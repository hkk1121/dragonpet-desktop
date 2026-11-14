const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  getAssets: () => ipcRenderer.invoke('pet:get-assets'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: cfg => ipcRenderer.invoke('config:save', cfg),
  setIgnoreMouse: ignore => ipcRenderer.send('pet:set-ignore-mouse', ignore),
  showContextMenu: () => ipcRenderer.send('pet:context-menu'),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.invoke('pet:drag-end'),
  moveBy: dx => ipcRenderer.invoke('pet:move-by', dx),
  peek: out => ipcRenderer.send('pet:peek', out),
  sendChat: (text, state) => ipcRenderer.send('chat:send', text, state),
  listModels: (apiKey, baseURL, proxy) => ipcRenderer.invoke('models:list', apiKey, baseURL, proxy),
  listScreens: () => ipcRenderer.invoke('screen:list'),
  getStats: () => ipcRenderer.invoke('stats:get'),
  saveStats: stats => ipcRenderer.send('stats:save', stats),
  getCursor: () => ipcRenderer.invoke('pet:get-cursor'),
  edge: (side, pinned) => ipcRenderer.send('pet:edge', side, pinned),
  nebula: on => ipcRenderer.invoke('pet:nebula', on),
  on: (channel, callback) => ipcRenderer.on(channel, (e, ...args) => callback(...args)),
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  openReleases: () => ipcRenderer.send('update:releases')
});
