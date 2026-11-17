export type CliProviderId = 'codex-cli' | 'claude-cli';

export interface CliToolStatus {
  provider: CliProviderId;
  binaryName: 'codex' | 'claude';
  installed: boolean;
  binaryPath: string | null;
  loggedIn: boolean;
  statusMessage: string;
}

export interface CliUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface CliRunRequest {
  runId: string;
  provider: CliProviderId;
  prompt: string;
  model?: string;
  cliSessionId?: string;
  cwd?: string;
}

export type CliIpcEvent =
  | { runId: string; type: 'session'; sessionId: string }
  | { runId: string; type: 'chunk'; chunk: string }
  | { runId: string; type: 'reasoning'; chunk: string }
  | { runId: string; type: 'usage'; usage: CliUsage }
  | { runId: string; type: 'error'; message: string }
  | { runId: string; type: 'finish' };

export interface QaxiomDesktopBridge {
  isDesktop: boolean;
  getCliStatuses: () => Promise<Record<CliProviderId, CliToolStatus>>;
  openCliLogin: (provider: CliProviderId) => Promise<CliToolStatus>;
  runCli: (request: CliRunRequest) => Promise<void>;
  abortCli: (runId: string) => Promise<void>;
  onCliEvent: (listener: (event: CliIpcEvent) => void) => () => void;
}

declare global {
  interface Window {
    qaxiomDesktop?: QaxiomDesktopBridge;
  }
}
