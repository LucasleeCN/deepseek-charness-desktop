'use strict'
/**
 * DeepSeek Harness Desktop — preload bridge (clean-room implementation).
 *
 * Exposes a minimal, frozen window-control surface to the trusted shell page
 * (shell.html) only. The harness content view loads WITHOUT this preload.
 *
 * Contract surface (kept stable for the shell page and QA):
 *   window.desktopWindow = { minimize, toggleMaximize, close, getState,
 *                            onStateChange, onPageTitle }
 */

const { contextBridge, ipcRenderer } = require('electron')

/** Send a window-control action to the main process. */
function sendControl(action) {
  ipcRenderer.send('desktop:window-control', action)
}

/** Subscribe to a main-process push event and return an unsubscribe fn. */
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('desktopWindow', Object.freeze({
  minimize: () => sendControl('minimize'),
  toggleMaximize: () => sendControl('toggle-maximize'),
  close: () => sendControl('close'),
  getState: () => ipcRenderer.invoke('desktop:get-window-state'),
  onStateChange: callback => subscribe('desktop:window-state', callback),
  onPageTitle: callback => subscribe('desktop:page-title', callback),
}))
