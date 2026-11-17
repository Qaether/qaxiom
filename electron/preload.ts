import { contextBridge, ipcRenderer } from 'electron';
import type { CliProviderId, CliRunRequest, CliToolStatus, CliUsage } from './cliRunner';

export type CliIpcEvent =
  | { runId: string; type: 'session'; sessionId: string }
  | { runId: string; type: 'chunk'; chunk: string }
  | { runId: string; type: 'reasoning'; chunk: string }
  | { runId: string; type: 'usage'; usage: CliUsage }
  | { runId: string; type: 'error'; message: string }
  | { runId: string; type: 'finish' };

const desktopApi = {
  isDesktop: true,
  getCliStatuses: (): Promise<Record<CliProviderId, CliToolStatus>> =>
    ipcRenderer.invoke('cli:status'),
  openCliLogin: (provider: CliProviderId): Promise<CliToolStatus> =>
    ipcRenderer.invoke('cli:login', provider),
  runCli: (request: CliRunRequest): Promise<void> =>
    ipcRenderer.invoke('cli:run', request),
  abortCli: (runId: string): Promise<void> =>
    ipcRenderer.invoke('cli:abort', runId),
  onCliEvent: (listener: (event: CliIpcEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: CliIpcEvent) => {
      listener(payload);
    };
    ipcRenderer.on('cli:event', handler);
    return () => {
      ipcRenderer.removeListener('cli:event', handler);
    };
  }
};

contextBridge.exposeInMainWorld('qaxiomDesktop', desktopApi);
