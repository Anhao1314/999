const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relaySettings", Object.freeze({
  status: () => ipcRenderer.invoke("relay-jev-status"),
  save: (key) => ipcRenderer.invoke("relay-jev-save", key),
  remove: () => ipcRenderer.invoke("relay-jev-remove"),
  test: () => ipcRenderer.invoke("relay-jev-test"),
  deepseekStatus: () => ipcRenderer.invoke("relay-deepseek-status"),
  deepseekSave: (key) => ipcRenderer.invoke("relay-deepseek-save", key),
  deepseekRemove: () => ipcRenderer.invoke("relay-deepseek-remove"),
  deepseekTest: () => ipcRenderer.invoke("relay-deepseek-test"),
}));
