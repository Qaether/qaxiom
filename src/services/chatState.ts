import type { ChatMessage, MessageStatus, ResearchMode } from '../types';

export const EMPTY_RESPONSE_MESSAGE = '모델이 텍스트를 반환하지 않았습니다. 다시 시도하거나 다른 모델을 선택해 주세요.';
export const STOPPED_RESPONSE_MESSAGE = '응답 생성을 중단했습니다. 이미 생성된 내용은 보존됩니다.';

type TerminalOutcome =
  | { type: 'finish' }
  | { type: 'stop' }
  | { type: 'error'; message: string };

export function createUserMessage(content: string): ChatMessage {
  return {
    id: `msg_${crypto.randomUUID()}`,
    role: 'user',
    content,
    timestamp: Date.now()
  };
}

export function createAssistantMessage(
  model: string,
  researchMode: ResearchMode
): ChatMessage {
  return {
    id: `msg_${crypto.randomUUID()}`,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    model,
    researchMode,
    isStreaming: true,
    status: 'streaming'
  };
}

export function appendAssistantChunk(message: ChatMessage, chunk: string): ChatMessage {
  return {
    ...message,
    content: message.content + chunk,
    isStreaming: true,
    status: 'streaming',
    errorMessage: undefined
  };
}

export function settleAssistantMessage(
  message: ChatMessage,
  outcome: TerminalOutcome
): ChatMessage {
  let status: MessageStatus;
  let errorMessage: string | undefined;

  if (outcome.type === 'stop') {
    status = 'stopped';
    errorMessage = STOPPED_RESPONSE_MESSAGE;
  } else if (outcome.type === 'error') {
    status = 'error';
    errorMessage = outcome.message;
  } else if (!message.content.trim()) {
    status = 'error';
    errorMessage = EMPTY_RESPONSE_MESSAGE;
  } else {
    status = 'complete';
  }

  return {
    ...message,
    isStreaming: false,
    status,
    errorMessage
  };
}

export interface RetryContext {
  prompt: string;
  history: ChatMessage[];
}

export function getRetryContext(
  messages: ChatMessage[],
  assistantMessageId: string
): RetryContext | null {
  const assistantIndex = messages.findIndex(message => message.id === assistantMessageId);
  if (assistantIndex !== messages.length - 1 || assistantIndex < 1) return null;

  const assistant = messages[assistantIndex];
  const user = messages[assistantIndex - 1];
  if (
    assistant.role !== 'assistant'
    || (assistant.status !== 'error' && assistant.status !== 'stopped')
    || user.role !== 'user'
  ) {
    return null;
  }

  return {
    prompt: user.content,
    history: messages.slice(0, assistantIndex)
  };
}
