const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pickerAPI', {
    getSources: () => ipcRenderer.invoke('get-desktop-sources'),
    confirm: (sourceId, audio) => ipcRenderer.send('picker-result', { sourceId, audio }),
    cancel: () => ipcRenderer.send('picker-result', null),
    getPlatform: () => ipcRenderer.invoke('get-platform'),
});
