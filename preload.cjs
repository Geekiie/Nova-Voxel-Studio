const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('novaFS', {
  pickDirectory: () => ipcRenderer.invoke('nova:pickDirectory'),
  listCubFiles: (rootDir, query) => ipcRenderer.invoke('nova:listCubFiles', { rootDir, query }),
  listDbFiles: (rootDir) => ipcRenderer.invoke('nova:listDbFiles', { rootDir }),
  listDbAssets: (dbPath, query) => ipcRenderer.invoke('nova:listDbAssets', { dbPath, query }),
  readDbAsset: (dbPath, key) => ipcRenderer.invoke('nova:readDbAsset', { dbPath, key }),
  replaceDbAsset: (dbPath, key, valueBuffer) => ipcRenderer.invoke('nova:replaceDbAsset', { dbPath, key, valueBuffer }),
  createDbBackup: (dbPath, outDir) => ipcRenderer.invoke('nova:createDbBackup', { dbPath, outDir }),
  readFile: (filePath) => ipcRenderer.invoke('nova:readFile', { path: filePath }),
  saveProject: (suggestedName, arrayBuffer) => ipcRenderer.invoke('nova:saveProject', { suggestedName, arrayBuffer }),
  openProject: () => ipcRenderer.invoke('nova:openProject', {}),
})
