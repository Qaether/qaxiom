// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCliArgs, parseCodexJsonLine } from '../../../electron/cliRunner';
import type { ChatMessage, ModelOption } from '../../types';
import type { CliIpcEvent, QaxiomDesktopBridge } from '../../types/desktop';
import { formatCliPrompt, streamCli } from './cli';

const CODEX_MODEL: ModelOption = {
  id: 'codex-cli',
  name: 'Codex CLI (Local)',
  provider: 'codex-cli',
  description: 'Local Codex CLI',
  status: 'active',
  api: 'cli',
  supportsTemperature: false,
  verifiedAt: '2026-11-17'
};

describe('CLI provider & runner helpers', () => {
  afterEach(() => {
    delete window.qaxiomDesktop;
    vi.restoreAllMocks();
  });

  it('builds fresh and resume args for codex-cli', () => {
    expect(buildCliArgs({
      runId: 'r1',
      provider: 'codex-cli',
      prompt: 'hi'
    })).toEqual(['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-']);

    expect(buildCliArgs({
      runId: 'r2',
      provider: 'codex-cli',
      prompt: 'follow up',
      cliSessionId: 'thread-123'
    })).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check', '--all', 'thread-123', '-']);
  });

  it('parses Codex JSONL session, message, and usage events', () => {
    expect(parseCodexJsonLine('{"type":"thread.started","thread_id":"t-1"}')).toEqual([
      { type: 'session', sessionId: 't-1' }
    ]);
    expect(parseCodexJsonLine('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}')).toEqual([
      { type: 'text', text: 'PONG', mode: 'full' }
    ]);
    expect(parseCodexJsonLine('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":12}}')).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 100,
          outputTokens: 12,
          cacheReadTokens: 40,
          cacheWriteTokens: undefined,
          totalTokens: 112
        }
      }
    ]);
  });

  it('formats full history on new CLI session and latest user turn when resuming', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'First question', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'First answer', timestamp: 2 },
      { id: 'u2', role: 'user', content: 'Follow up', timestamp: 3 }
    ];

    const freshPrompt = formatCliPrompt(messages, 'Be concise.');
    expect(freshPrompt).toContain('[System Instructions]\nBe concise.');
    expect(freshPrompt).toContain('[User]\nFirst question');
    expect(freshPrompt).toContain('[Assistant]\nFirst answer');
    expect(freshPrompt).toContain('[User]\nFollow up');

    const resumePrompt = formatCliPrompt(messages, 'Be concise.', 'thread-123');
    expect(resumePrompt).not.toContain('First question');
    expect(resumePrompt).toContain('[User Request]\nFollow up');
  });

  it('streams chunks, session id, and usage through window.qaxiomDesktop', async () => {
    let listener: ((event: CliIpcEvent) => void) | null = null;
    const bridge: QaxiomDesktopBridge = {
      isDesktop: true,
      getCliStatuses: vi.fn(),
      openCliLogin: vi.fn(),
      abortCli: vi.fn().mockResolvedValue(undefined),
      onCliEvent: cb => {
        listener = cb;
        return () => {
          listener = null;
        };
      },
      runCli: vi.fn().mockImplementation(async req => {
        listener?.({ runId: req.runId, type: 'session', sessionId: 'thread-abc' });
        listener?.({ runId: req.runId, type: 'chunk', chunk: 'Hello ' });
        listener?.({ runId: req.runId, type: 'chunk', chunk: 'world' });
        listener?.({ runId: req.runId, type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } });
        listener?.({ runId: req.runId, type: 'finish' });
      })
    };
    window.qaxiomDesktop = bridge;

    const chunks: string[] = [];
    let capturedSessionId = '';
    let finished = false;

    await streamCli(
      [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }],
      CODEX_MODEL,
      'System',
      {
        onSessionId: id => { capturedSessionId = id; },
        onChunk: c => chunks.push(c),
        onError: err => { throw err; },
        onFinish: () => { finished = true; }
      }
    );

    expect(capturedSessionId).toBe('thread-abc');
    expect(chunks.join('')).toBe('Hello world');
    expect(finished).toBe(true);
  });
});
