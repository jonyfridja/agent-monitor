import { contextBridge, ipcRenderer } from 'electron';

// The renderer gets exactly these calls and nothing else (no node, no raw ipcRenderer).
contextBridge.exposeInMainWorld('am', {
  onState(cb: (state: unknown) => void) {
    ipcRenderer.on('state', (_e, state) => cb(state));
    void ipcRenderer.invoke('state').then(cb);
  },
  setAgent: (id: string, enabled: boolean) => ipcRenderer.invoke('agent:set', id, enabled),
  reinstall: (id: string) => ipcRenderer.invoke('agent:reinstall', id),
  startServer: () => ipcRenderer.invoke('server:start'),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  copyUrl: () => ipcRenderer.invoke('url:copy'),
  setShareTranscripts: (value: boolean) => ipcRenderer.invoke('transcripts:set', value),
  setLaunchAtLogin: (value: boolean) => ipcRenderer.invoke('login:set', value),
  quit: () => ipcRenderer.invoke('app:quit'),
});
