import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { runTurn } from '../harness/runTurn';
import { CheckpointTracker, createSessionEvent } from '../harness/sessionEvents';
import { appendSessionEvent } from '../services/database';
import { appendAssistantChunk, settleAssistantMessage } from '../services/chatState';
import { parseMessageFileChanges } from '../services/fileChanges';
import type { ContextBundle } from '../services/retrieval/types';
import type { ChatMessage, ChatSession, DocumentChatContext, ResearchMode, UserSettings } from '../types';

export interface ExecuteChatTurnInput {
  sessionId: string;
  assistantMessageId: string;
  modelId: string;
  researchMode: ResearchMode;
  settings: UserSettings;
  messages: ChatMessage[];
  contextBundle?: ContextBundle;
  documentContext?: DocumentChatContext;
  onProposedChange?: (proposedContent: string) => void;
}

export function useHarnessSession(
  setSessions: Dispatch<SetStateAction<ChatSession[]>>
) {
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeStreamRef = useRef<{ sessionId: string; messageId: string } | null>(null);
  const stoppedMessageIdsRef = useRef(new Set<string>());

  const stopStreaming = useCallback(() => {
    const activeStream = activeStreamRef.current;
    if (activeStream) {
      stoppedMessageIdsRef.current.add(activeStream.messageId);
      setSessions(prev =>
        prev.map(session => {
          if (session.id !== activeStream.sessionId) return session;
          return {
            ...session,
            messages: session.messages.map(message =>
              message.id === activeStream.messageId
                ? settleAssistantMessage(message, { type: 'stop' })
                : message
            )
          };
        })
      );
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, [setSessions]);

  const executeChatTurn = useCallback(async (input: ExecuteChatTurnInput) => {
    const {
      sessionId,
      assistantMessageId,
      modelId,
      researchMode,
      settings,
      messages,
      contextBundle,
      documentContext,
      onProposedChange
    } = input;

    const turnId = `turn-${assistantMessageId}`;
    let seq = 1;
    let accumulated = '';
    const tracker = new CheckpointTracker();

    const recordEvent = (type: Parameters<typeof createSessionEvent>[0]['type'], payload?: Record<string, unknown>) => {
      const event = createSessionEvent({
        sessionId,
        turnId,
        messageId: assistantMessageId,
        seq: seq++,
        type,
        payload
      });
      void appendSessionEvent(event).catch(() => undefined);
    };

    setIsStreaming(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    activeStreamRef.current = { sessionId, messageId: assistantMessageId };
    recordEvent('turn_started', { modelId, researchMode });

    try {
      const result = await runTurn(
        {
          kind: 'chat',
          messages,
          modelId,
          researchMode,
          settings,
          contextBundle,
          documentContext
        },
        {
          signal: controller.signal,
          callbacks: {
            onChunk: (chunk: string) => {
              if (stoppedMessageIdsRef.current.has(assistantMessageId)) return;
              accumulated += chunk;
              if (tracker.shouldFlush(accumulated.length)) {
                tracker.markFlushed(accumulated.length);
                recordEvent('turn_checkpoint', { content: accumulated });
              }
              setSessions(prev =>
                prev.map(s => {
                  if (s.id !== sessionId) return s;
                  return {
                    ...s,
                    messages: s.messages.map(m =>
                      m.id === assistantMessageId
                        ? appendAssistantChunk(m, chunk)
                        : m
                    )
                  };
                })
              );
            }
          }
        }
      );

      const wasStopped = stoppedMessageIdsRef.current.delete(assistantMessageId) || result.aborted;
      if (activeStreamRef.current?.messageId === assistantMessageId) {
        setIsStreaming(false);
        activeStreamRef.current = null;
        abortControllerRef.current = null;
      }

      if (wasStopped) {
        recordEvent('turn_cancelled', { content: accumulated || result.text });
      } else {
        recordEvent('turn_completed', {
          content: result.text || accumulated,
          durationMs: result.durationMs,
          usage: result.usage
        });
      }

      setSessions(prev =>
        prev.map(s => {
          if (s.id !== sessionId) return s;
          const nextMessages = s.messages.map(m =>
            m.id === assistantMessageId
              ? settleAssistantMessage(m, { type: wasStopped ? 'stop' : 'finish' })
              : m
          );
          if (!wasStopped && onProposedChange) {
            const finishedMsg = nextMessages.find(m => m.id === assistantMessageId);
            if (finishedMsg?.content) {
              const parsed = parseMessageFileChanges(
                finishedMsg.content,
                'document.md',
                documentContext?.markdown
              );
              if (parsed.fileChanges.length > 0) {
                onProposedChange(parsed.fileChanges[0].proposedContent);
              }
            }
          }
          return { ...s, messages: nextMessages };
        })
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (activeStreamRef.current?.messageId === assistantMessageId) {
        setIsStreaming(false);
        activeStreamRef.current = null;
        abortControllerRef.current = null;
      }
      recordEvent('turn_failed', { content: accumulated, error: err.message });
      setSessions(prev =>
        prev.map(s => {
          if (s.id !== sessionId) return s;
          return {
            ...s,
            messages: s.messages.map(m =>
              m.id === assistantMessageId
                ? settleAssistantMessage(m, { type: 'error', message: err.message })
                : m
            )
          };
        })
      );
    }
  }, [setSessions]);

  return {
    isStreaming,
    stopStreaming,
    executeChatTurn
  };
}
