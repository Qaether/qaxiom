import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

export type ParsedCliEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string; mode: 'delta' | 'full' }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: CliUsage }
  | { type: 'error'; message: string };

export interface CliRunRequest {
  runId: string;
  provider: CliProviderId;
  prompt: string;
  model?: string;
  cliSessionId?: string;
  cwd?: string;
}

export interface CliRunCallbacks {
  onSessionId: (sessionId: string) => void;
  onChunk: (chunk: string) => void;
  onReasoningSummary?: (chunk: string) => void;
  onUsage?: (usage: CliUsage) => void;
  onLog?: (entry: { stream: 'cmd' | 'stdout' | 'stderr'; line: string }) => void;
  onError: (error: Error) => void;
  onFinish: () => void;
}

function getAugmentedPath(basePath = process.env.PATH || ''): string {
  const home = os.homedir();
  const extraDirs =
    process.platform === 'win32'
      ? [
          path.join(home, 'AppData', 'Roaming', 'npm'),
          path.join(home, '.local', 'bin')
        ]
      : [
          '/opt/homebrew/bin',
          '/usr/local/bin',
          path.join(home, '.npm-global', 'bin'),
          path.join(home, '.local', 'bin'),
          path.join(home, '.volta', 'bin'),
          '/usr/bin',
          '/bin'
        ];
  const parts = basePath.split(path.delimiter).filter(Boolean);
  for (const dir of extraDirs) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(path.delimiter);
}

export function resolveCliBinary(name: 'codex' | 'claude'): string | null {
  const pathEnv = getAugmentedPath();
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Ignore inaccessible paths
      }
    }
  }
  return null;
}

export async function checkCliStatus(provider: CliProviderId): Promise<CliToolStatus> {
  const binaryName = provider === 'codex-cli' ? 'codex' : 'claude';
  const binaryPath = resolveCliBinary(binaryName);

  if (!binaryPath) {
    return {
      provider,
      binaryName,
      installed: false,
      binaryPath: null,
      loggedIn: false,
      statusMessage: `${binaryName} CLI is not installed on this machine.`
    };
  }

  const env = { ...process.env, PATH: getAugmentedPath() };

  if (binaryName === 'codex') {
    try {
      const { stdout, stderr } = await execFileAsync(binaryPath, ['login', 'status'], {
        env,
        timeout: 5000
      });
      const combined = `${stdout || ''}\n${stderr || ''}`.trim();
      const loggedOut = /not logged in|logged out|unauthenticated/i.test(combined);
      return {
        provider,
        binaryName,
        installed: true,
        binaryPath,
        loggedIn: !loggedOut,
        statusMessage: combined || (loggedOut ? 'Not logged in.' : 'Logged in.')
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        provider,
        binaryName,
        installed: true,
        binaryPath,
        loggedIn: false,
        statusMessage: msg || 'Codex login required (`codex login`).'
      };
    }
  }

  // Claude Code CLI auth check
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, ['auth', 'status'], {
      env,
      timeout: 5000
    });
    const combined = `${stdout || ''}\n${stderr || ''}`.trim();
    const loggedOut = /not logged in|logged out|unauthenticated|false/i.test(combined);
    return {
      provider,
      binaryName,
      installed: true,
      binaryPath,
      loggedIn: !loggedOut,
      statusMessage: combined || (loggedOut ? 'Claude login required.' : 'Logged in.')
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      provider,
      binaryName,
      installed: true,
      binaryPath,
      loggedIn: false,
      statusMessage: msg || 'Claude CLI login required (`claude login`).'
    };
  }
}

export function buildCliArgs(request: CliRunRequest): string[] {
  if (request.provider === 'codex-cli') {
    if (request.cliSessionId) {
      return [
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        '--all',
        ...(request.model ? ['-m', request.model] : []),
        request.cliSessionId,
        '-'
      ];
    }
    return [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      ...(request.model ? ['-m', request.model] : []),
      '-'
    ];
  }

  // claude-cli non-interactive stream-json
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(request.cliSessionId ? ['--resume', request.cliSessionId] : []),
    ...(request.model ? ['--model', request.model] : [])
  ];
}

export function parseCodexJsonLine(line: string): ParsedCliEvent[] {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }

  const events: ParsedCliEvent[] = [];
  const type = typeof parsed.type === 'string' ? parsed.type : '';

  if (type === 'thread.started' && typeof parsed.thread_id === 'string') {
    events.push({ type: 'session', sessionId: parsed.thread_id });
    return events;
  }

  if (typeof parsed.session_id === 'string' && parsed.session_id) {
    events.push({ type: 'session', sessionId: parsed.session_id });
  }

  if (type === 'item.delta' || type === 'response.output_text.delta') {
    const deltaText =
      typeof parsed.delta === 'string'
        ? parsed.delta
        : typeof parsed.text === 'string'
          ? parsed.text
          : '';
    if (deltaText) {
      events.push({ type: 'text', text: deltaText, mode: 'delta' });
    }
    return events;
  }

  if (type === 'item.completed' || type === 'item.updated') {
    const item = parsed.item as Record<string, unknown> | undefined;
    if (item && typeof item === 'object') {
      const itemType = typeof item.type === 'string' ? item.type : '';
      const text = typeof item.text === 'string' ? item.text : '';
      if (itemType === 'agent_message' && text) {
        events.push({ type: 'text', text, mode: 'full' });
      } else if (itemType === 'reasoning' && text) {
        events.push({ type: 'reasoning', text });
      }
    }
    return events;
  }

  // Claude stream-json compatibility
  if (type === 'assistant' && parsed.message && typeof parsed.message === 'object') {
    const message = parsed.message as { content?: Array<{ type?: string; text?: string }> };
    const text = (message.content || [])
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text as string)
      .join('');
    if (text) {
      events.push({ type: 'text', text, mode: 'full' });
    }
    return events;
  }

  if (type === 'result' && typeof parsed.result === 'string' && parsed.result) {
    events.push({ type: 'text', text: parsed.result, mode: 'full' });
    return events;
  }

  if (type === 'turn.completed' && parsed.usage && typeof parsed.usage === 'object') {
    const rawUsage = parsed.usage as Record<string, unknown>;
    const inputTokens = typeof rawUsage.input_tokens === 'number' ? rawUsage.input_tokens : undefined;
    const outputTokens = typeof rawUsage.output_tokens === 'number' ? rawUsage.output_tokens : undefined;
    const cacheReadTokens = typeof rawUsage.cached_input_tokens === 'number' ? rawUsage.cached_input_tokens : undefined;
    const cacheWriteTokens =
      typeof rawUsage.cache_write_input_tokens === 'number' ? rawUsage.cache_write_input_tokens : undefined;
    events.push({
      type: 'usage',
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens:
          typeof inputTokens === 'number' && typeof outputTokens === 'number'
            ? inputTokens + outputTokens
            : undefined
      }
    });
    return events;
  }

  if (type === 'error' || type === 'turn.failed') {
    const errMsg =
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof (parsed.error as { message?: unknown } | undefined)?.message === 'string'
          ? String((parsed.error as { message: string }).message)
          : 'CLI execution failed.';
    events.push({ type: 'error', message: errMsg });
  }

  return events;
}

export function spawnCliTurn(
  request: CliRunRequest,
  callbacks: CliRunCallbacks
): { cancel: () => void } {
  const binaryName = request.provider === 'codex-cli' ? 'codex' : 'claude';
  const binaryPath = resolveCliBinary(binaryName);

  if (!binaryPath) {
    callbacks.onError(new Error(`${binaryName} CLI is not installed.`));
    return { cancel: () => {} };
  }

  const args = buildCliArgs(request);
  const env = { ...process.env, PATH: getAugmentedPath() };
  const cwd = request.cwd && fs.existsSync(request.cwd) ? request.cwd : os.homedir();

  let child: ChildProcess | null = null;
  let aborted = false;
  let settled = false;
  let buffer = '';
  let emittedText = '';
  let stderrText = '';

  const finishOnce = (err?: Error) => {
    if (settled) return;
    settled = true;
    if (err) {
      callbacks.onError(err);
    } else {
      callbacks.onFinish();
    }
  };

  try {
    callbacks.onLog?.({ stream: 'cmd', line: `$ ${binaryName} ${args.join(' ')}` });
    child = spawn(binaryPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    finishOnce(error instanceof Error ? error : new Error(String(error)));
    return { cancel: () => {} };
  }

  const handleParsed = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const events = parseCodexJsonLine(trimmed);
    if (events.length === 0 && !trimmed.startsWith('{')) {
      callbacks.onLog?.({ stream: 'stdout', line: trimmed });
    }
    for (const evt of events) {
      if (evt.type === 'session') {
        callbacks.onLog?.({ stream: 'cmd', line: `[session] ${evt.sessionId}` });
        callbacks.onSessionId(evt.sessionId);
      } else if (evt.type === 'reasoning') {
        callbacks.onLog?.({ stream: 'stdout', line: `[reasoning] ${evt.text}` });
        callbacks.onReasoningSummary?.(evt.text);
      } else if (evt.type === 'text') {
        if (evt.mode === 'full') {
          callbacks.onLog?.({ stream: 'stdout', line: `[response] ${evt.text.length} chars received` });
        }
        if (evt.mode === 'delta') {
          emittedText += evt.text;
          callbacks.onChunk(evt.text);
        } else {
          if (evt.text.startsWith(emittedText)) {
            const diff = evt.text.slice(emittedText.length);
            if (diff) {
              emittedText = evt.text;
              callbacks.onChunk(diff);
            }
          } else if (evt.text !== emittedText) {
            emittedText += evt.text;
            callbacks.onChunk(evt.text);
          }
        }
      } else if (evt.type === 'usage') {
        callbacks.onLog?.({
          stream: 'cmd',
          line: `[usage] in=${evt.usage.inputTokens ?? 0}, cached=${evt.usage.cacheReadTokens ?? 0}, out=${evt.usage.outputTokens ?? 0}`
        });
        callbacks.onUsage?.(evt.usage);
      } else if (evt.type === 'error') {
        callbacks.onLog?.({ stream: 'stderr', line: `[error] ${evt.message}` });
        finishOnce(new Error(evt.message));
      }
    }
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      handleParsed(line);
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrText += chunk;
    for (const line of chunk.split('\n')) {
      if (line.trim()) callbacks.onLog?.({ stream: 'stderr', line: line.trim() });
    }
  });

  child.on('error', err => {
    finishOnce(err);
  });

  child.on('close', code => {
    if (buffer.trim()) {
      handleParsed(buffer);
      buffer = '';
    }
    callbacks.onLog?.({ stream: 'cmd', line: `[${binaryName} exited with code ${code ?? 'null'}]` });
    if (aborted) {
      finishOnce(new Error('Aborted'));
      return;
    }
    if (code !== 0 && !settled) {
      const detail = stderrText.trim() || `${binaryName} exited with code ${code}`;
      finishOnce(new Error(detail));
      return;
    }
    finishOnce();
  });

  child.stdin?.write(request.prompt, 'utf8');
  child.stdin?.end();

  return {
    cancel: () => {
      aborted = true;
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
    }
  };
}
