import { describe, expect, it, vi } from 'vitest';
import { consumeJsonSSE, parseSSE } from './sse';

function streamFromBytes(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(chunk));
      controller.close();
    }
  });
}

function streamFromText(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return streamFromBytes(chunks.map(chunk => encoder.encode(chunk)));
}

describe('parseSSE', () => {
  it('parses metadata, comments, multiline data, and a final unterminated event', async () => {
    const stream = streamFromText(
      ': keepalive\r\nid: 7\r\nevent: message\r\ndata: {"value":\r\n',
      'data: 1}\r\nretry: 1000\r\n\r\ndata: tail'
    );

    const events = [];
    for await (const event of parseSSE(stream)) events.push(event);

    expect(events).toEqual([
      { data: '{"value":\n1}', event: 'message', id: '7', retry: 1000 },
      { data: 'tail', event: undefined, id: undefined, retry: undefined }
    ]);
  });

  it('preserves UTF-8 characters split across byte chunks', async () => {
    const bytes = new TextEncoder().encode('data: {"text":"가"}\n\n');
    const splitAt = bytes.indexOf(0xea) + 1;
    const stream = streamFromBytes([bytes.slice(0, splitAt), bytes.slice(splitAt)]);

    const events = [];
    for await (const event of parseSSE(stream)) events.push(event);

    expect(events[0]?.data).toBe('{"text":"가"}');
  });
});

describe('consumeJsonSSE', () => {
  it('decodes JSON events and stops at the DONE sentinel', async () => {
    const onEvent = vi.fn();
    const stream = streamFromText(
      'data: {"delta":"A"}\n\n',
      'data: [DONE]\n\n',
      'data: {"delta":"ignored"}\n\n'
    );

    await consumeJsonSSE(stream, onEvent);

    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls[0]?.[0]).toEqual({ delta: 'A' });
  });

  it('rejects malformed JSON instead of silently dropping output', async () => {
    const stream = streamFromText('data: {broken}\n\n');

    await expect(consumeJsonSSE(stream, vi.fn())).rejects.toThrow(
      '스트리밍 응답에 올바르지 않은 JSON 이벤트가 포함되어 있습니다.'
    );
  });
});
