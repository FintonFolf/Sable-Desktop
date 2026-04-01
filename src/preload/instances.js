const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('instancesAPI', {
    getKnownInstances: () => ipcRenderer.invoke('get-known-instances'),
    getInstances:      () => ipcRenderer.invoke('get-instances'),
    selectInstance:    (instance) => ipcRenderer.invoke('select-instance', instance),
    addInstance:       (instance) => ipcRenderer.invoke('add-instance', instance),
    removeInstance:    (url) => ipcRenderer.invoke('remove-instance', url),
    switchInstance:    (url) => ipcRenderer.invoke('switch-instance', url),
});
