import type { ChatMessage, ModelOption } from '../../types';
import type { CliProviderId } from '../../types/desktop';
import { flattenSystemBlocks, type ProviderCallbacks, type SystemBlock } from './types';

export function formatCliPrompt(
  messages: ChatMessage[],
  system: string | SystemBlock[],
  cliSessionId?: string
): string {
  const systemText = flattenSystemBlocks(system).trim();

  if (cliSessionId) {
    // Resuming an existing CLI thread: send the latest user turn (which already
    // includes any updated documentContext / contextBundle) without duplicating full history.
    const latestUser = [...messages].reverse().find(m => m.role === 'user');
    const turnBody = latestUser?.content?.trim() || messages[messages.length - 1]?.content?.trim() || '';
    if (!systemText) return turnBody;
    return `[Active Mode & Output Instructions]\n${systemText}\n\n[User Request]\n${turnBody}`;
  }

  const parts: string[] = [];
  if (systemText) {
    parts.push(`[System Instructions]\n${systemText}`);
  }
  const conversation = messages
    .filter(m => m.role !== 'system')
    .map(m => `[${m.role === 'user' ? 'User' : 'Assistant'}]\n${m.content.trim()}`)
    .join('\n\n');
  if (conversation) {
    parts.push(conversation);
  }
  return parts.join('\n\n');
}

export async function streamCli(
  messages: ChatMessage[],
  model: ModelOption,
  system: string | SystemBlock[],
  callbacks: ProviderCallbacks,
  options: { cliSessionId?: string; signal?: AbortSignal } = {}
): Promise<void> {
  const desktop = typeof window !== 'undefined' ? window.qaxiomDesktop : undefined;
  if (!desktop?.isDesktop) {
    throw new Error('Local CLI execution requires the Qaxiom Electron desktop app.');
  }

  const provider = model.provider as CliProviderId;
  const runId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const prompt = formatCliPrompt(messages, system, options.cliSessionId);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => {};

    const cleanup = () => {
      unsubscribe();
      options.signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      void desktop.abortCli(runId);
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('Aborted'));
      }
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    unsubscribe = desktop.onCliEvent(event => {
      if (event.runId !== runId || settled) return;
      if (event.type === 'session') {
        callbacks.onSessionId?.(event.sessionId);
      } else if (event.type === 'chunk') {
        callbacks.onChunk(event.chunk);
      } else if (event.type === 'reasoning') {
        callbacks.onReasoningSummary?.(event.chunk);
      } else if (event.type === 'usage') {
        callbacks.onUsage?.(event.usage);
      } else if (event.type === 'error') {
        settled = true;
        cleanup();
        const err = new Error(event.message);
        callbacks.onError(err);
        reject(err);
      } else if (event.type === 'finish') {
        settled = true;
        cleanup();
        callbacks.onFinish();
        resolve();
      }
    });

    void desktop
      .runCli({
        runId,
        provider,
        prompt,
        cliSessionId: options.cliSessionId
      })
      .catch(error => {
        if (settled) return;
        settled = true;
        cleanup();
        const err = error instanceof Error ? error : new Error(String(error));
        callbacks.onError(err);
        reject(err);
      });
  });
}
