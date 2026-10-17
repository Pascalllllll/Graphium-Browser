'use strict';

// Runs in every tab, but only gives anything to Graphium's own graphium:// pages.
// The main process checks the sender again before acting.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'graphium:') {
  contextBridge.exposeInMainWorld('graphium', {
    getSettings: () => ipcRenderer.invoke('page:get-settings'),
    set: (key, value) => ipcRenderer.invoke('page:set', key, value),
    action: (name, arg) => ipcRenderer.invoke('page:action', name, arg),
    onSettings: callback => ipcRenderer.on('settings-changed', (_event, data) => callback(data)),
  });
}
