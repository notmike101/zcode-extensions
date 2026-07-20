import {contextBridge, ipcRenderer} from "electron";

contextBridge.exposeInMainWorld("zcodeDesktopPlugins", Object.freeze({
  invoke: (method: string, payload?: unknown) => ipcRenderer.invoke("zdp:invoke", {method, payload}),
  on: (listener: (event: string, payload: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: {event: string; payload: unknown}) => {
      listener(message.event, message.payload);
    };
    ipcRenderer.on("zdp:event", handler);
    return () => ipcRenderer.removeListener("zdp:event", handler);
  },
}));
