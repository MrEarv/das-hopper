const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    selectBackupFolder: () => ipcRenderer.invoke('select-backup-folder'),
    getBackupsList: (carpetaBase) => ipcRenderer.invoke('get-backups-list', carpetaBase),
    checkBackupTarget: (datos) => ipcRenderer.invoke('check-backup-target', datos),
    deleteBackup: (datos) => ipcRenderer.invoke('delete-backup', datos),
    getAndroidFolders: () => ipcRenderer.invoke('get-android-folders'),
    startBackup: (selecciones) => ipcRenderer.invoke('start-backup', selecciones),
    startRestore: (datos) => ipcRenderer.invoke('start-restore', datos),
    cancelOperation: () => ipcRenderer.invoke('cancel-operation'),

    onEstadoDispositivo: (callback) => ipcRenderer.on('estado-dispositivo', (_event, data) => callback(data)),
    onBackupProgress: (callback) => ipcRenderer.on('backup-progress', (_event, data) => callback(data)),

    joinPath: (base, name) => `${base.replace(/[\\/]+$/, '')}\\${name.replace(/^[\\/]+/, '')}`
});