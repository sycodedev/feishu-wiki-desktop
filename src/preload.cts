import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopState, Action } from './shared.js';

const bridge: DesktopBridge = {
  getState: () => ipcRenderer.invoke('desktop:state'),
  perform: (action: Action) => ipcRenderer.invoke('desktop:action', action),
  onState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopState) => listener(state);
    ipcRenderer.on('desktop:state', handler);
    return () => ipcRenderer.removeListener('desktop:state', handler);
  },
  onFocusAddress: listener => {
    const handler = () => listener();
    ipcRenderer.on('desktop:focus-address', handler);
    return () => ipcRenderer.removeListener('desktop:focus-address', handler);
  },
};
contextBridge.exposeInMainWorld('wikiDesktop', bridge);
