export interface ServerSentEvent {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

function parseEventBlock(block: string): ServerSentEvent | null {
  const data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  for (const line of block.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(':')) continue;

    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') data.push(value);
    if (field === 'event') event = value;
    if (field === 'id' && !value.includes('\0')) id = value;
    if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  }

  if (data.length === 0) return null;
  return { data: data.join('\n'), event, id, retry };
}

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<ServerSentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.match(/\r?\n\r?\n|\r\r/);

      while (boundary?.index !== undefined) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parseEventBlock(block);
        if (event) yield event;
        boundary = buffer.match(/\r?\n\r?\n|\r\r/);
      }
    }

    buffer += decoder.decode();
    if (buffer) {
      const event = parseEventBlock(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function consumeJsonSSE(
  stream: ReadableStream<Uint8Array>,
  onEvent: (payload: unknown, event: ServerSentEvent) => void
): Promise<void> {
  for await (const event of parseSSE(stream)) {
    if (event.data === '[DONE]') return;

    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      throw new Error('스트리밍 응답에 올바르지 않은 JSON 이벤트가 포함되어 있습니다.');
    }
    onEvent(payload, event);
  }
}
