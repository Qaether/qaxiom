import { streamCli } from './cli';
import type { NormalizedProviderRequest, ProviderUsage } from './types';

/**
 * Normalized provider invocation router.
 * Enforces CLI-only execution (codex-cli / claude-cli) through the Electron desktop bridge.
 */
export async function invokeProvider(request: NormalizedProviderRequest): Promise<ProviderUsage | undefined> {
  const { model, messages, system, cliSessionId, callbacks, signal } = request;
  let capturedUsage: ProviderUsage | undefined;

  const wrappedCallbacks = {
    ...callbacks,
    onUsage: (usage: ProviderUsage) => {
      capturedUsage = usage;
      callbacks.onUsage?.(usage);
    }
  };

  switch (model.provider) {
    case 'codex-cli':
    case 'claude-cli':
      await streamCli(messages, model, system, wrappedCallbacks, { cliSessionId, signal });
      return capturedUsage;
    default:
      throw new Error(`Direct API providers are disabled. Use Codex CLI or Claude Code CLI (received: ${model.provider}).`);
  }
}
