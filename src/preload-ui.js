'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const OUT = new Set([
  'navigate', 'tab-new', 'tab-close', 'tab-activate', 'tab-move', 'tab-menu',
  'back', 'forward', 'reload', 'stop', 'home', 'shields', 'zoom-reset', 'open-popup',
  'menu', 'downloads', 'focus-page', 'ui-height', 'find', 'find-close', 'bookmark',
  'palette-close', 'palette-run',
]);
const IN = new Set(['state', 'focus-address', 'find-open', 'find-close', 'find-next', 'find-result', 'palette-open']);

contextBridge.exposeInMainWorld('graphium', {
  send(channel, ...args) {
    if (OUT.has(channel)) ipcRenderer.send('ui:' + channel, ...args);
  },
  complete: text => ipcRenderer.invoke('ui:complete', text),
  searchHistory: text => ipcRenderer.invoke('ui:palette-search', text),
  memory: () => ipcRenderer.invoke('ui:palette-memory'),
  on(channel, callback) {
    if (IN.has(channel)) ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },
});
