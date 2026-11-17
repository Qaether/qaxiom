import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import {
  checkCliStatus,
  resolveCliBinary,
  spawnCliTurn,
  type CliProviderId,
  type CliRunRequest,
  type CliToolStatus
} from './cliRunner';

const activeRuns = new Map<string, () => void>();

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Qaxiom',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
    void win.loadFile(indexPath);
  }
}

async function runCliLogin(provider: CliProviderId): Promise<CliToolStatus> {
  const binaryName = provider === 'codex-cli' ? 'codex' : 'claude';
  const binaryPath = resolveCliBinary(binaryName);
  if (!binaryPath) {
    return checkCliStatus(provider);
  }

  await new Promise<void>(resolve => {
    const child = spawn(binaryPath, ['login'], {
      stdio: 'ignore',
      detached: false
    });
    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGTERM');
      resolve();
    }, 120_000);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  return checkCliStatus(provider);
}

app.whenReady().then(() => {
  ipcMain.handle('cli:status', async () => {
    const [codex, claude] = await Promise.all([
      checkCliStatus('codex-cli'),
      checkCliStatus('claude-cli')
    ]);
    return {
      'codex-cli': codex,
      'claude-cli': claude
    };
  });

  ipcMain.handle('cli:login', async (_event, provider: CliProviderId) => {
    return runCliLogin(provider);
  });

  ipcMain.handle('cli:open-terminal', async (_event, provider: CliProviderId) => {
    const binaryName = provider === 'codex-cli' ? 'codex' : 'claude';
    const binaryPath = resolveCliBinary(binaryName) || binaryName;
    if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell application "Terminal" to do script "${binaryPath}"`, '-e', 'tell application "Terminal" to activate'], {
        stdio: 'ignore',
        detached: true
      });
    } else if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', binaryPath], { stdio: 'ignore', detached: true });
    }
  });

  ipcMain.handle('cli:run', async (event, request: CliRunRequest) => {
    const sender = event.sender;
    const send = (payload: Record<string, unknown>) => {
      if (!sender.isDestroyed()) {
        sender.send('cli:event', { runId: request.runId, ...payload });
      }
    };

    const { cancel } = spawnCliTurn(request, {
      onSessionId: sessionId => send({ type: 'session', sessionId }),
      onChunk: chunk => send({ type: 'chunk', chunk }),
      onReasoningSummary: chunk => send({ type: 'reasoning', chunk }),
      onUsage: usage => send({ type: 'usage', usage }),
      onLog: entry => send({ type: 'log', stream: entry.stream, line: entry.line }),
      onError: error => {
        activeRuns.delete(request.runId);
        send({ type: 'error', message: error.message });
      },
      onFinish: () => {
        activeRuns.delete(request.runId);
        send({ type: 'finish' });
      }
    });

    activeRuns.set(request.runId, cancel);
  });

  ipcMain.handle('cli:abort', async (_event, runId: string) => {
    const cancel = activeRuns.get(runId);
    if (cancel) {
      activeRuns.delete(runId);
      cancel();
    }
  });

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  for (const cancel of activeRuns.values()) {
    cancel();
  }
  activeRuns.clear();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Ensure dist-electron resolves as CommonJS when compiled
export function ensureDistElectronCommonJsMarker(dir = __dirname) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ type: 'commonjs' }, null, 2));
  }
}
