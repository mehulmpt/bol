const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bol', {
	getState: () => ipcRenderer.invoke('bol:get-state'),
	saveSettings: (settings) => ipcRenderer.invoke('bol:save-settings', settings),
	say: (text) => ipcRenderer.invoke('bol:say', text),
	interrupt: () => ipcRenderer.invoke('bol:interrupt'),
	reset: () => ipcRenderer.invoke('bol:reset'),
	hide: () => ipcRenderer.invoke('bol:hide'),
	transcribe: (payload) => ipcRenderer.invoke('bol:transcribe', payload),
	onEvent: (callback) => {
		const listener = (_event, payload) => callback(payload)
		ipcRenderer.on('bol-event', listener)
		return () => ipcRenderer.removeListener('bol-event', listener)
	},
})
