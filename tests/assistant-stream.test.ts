import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIProvider, type ToolSpec, type StreamEvent } from '@/lib/ai/provider';

// Build a fake streaming Response whose body yields the given SSE chunks.
function sseResponse(chunks: string[]) {
  let i = 0;
  const enc = new TextEncoder();
  return Promise.resolve({
    ok: true,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined }) }) },
  } as unknown as Response);
}

async function collect(gen: AsyncGenerator<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

afterEach(() => vi.restoreAllMocks());

describe('OpenAIProvider.runToolsStream', () => {
  it('streams content deltas when no tool is called', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(sseResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n',
    ])));
    const provider = new OpenAIProvider('gpt-4o', 'test-key');
    const events = await collect(provider.runToolsStream({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }));
    const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Hello world');
    expect(events.some((e) => e.type === 'action')).toBe(false);
  });

  it('accumulates streamed tool_call fragments, executes, then streams the reply', async () => {
    const fetchMock = vi.fn()
      // Round 1: a tool call streamed in argument fragments
      .mockReturnValueOnce(sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"add_note","arguments":"{\\"bo"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"dy\\":\\"hi\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]))
      // Round 2: final natural-language answer
      .mockReturnValueOnce(sseResponse([
        'data: {"choices":[{"delta":{"content":"Saved it."}}]}\n\n',
        'data: [DONE]\n\n',
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const got: Record<string, unknown>[] = [];
    const tools: ToolSpec[] = [{
      name: 'add_note', description: 'x', input_schema: { type: 'object' },
      execute: async (args) => { got.push(args); return { ok: true, summary: 'Saved a note.' }; },
    }];
    const provider = new OpenAIProvider('gpt-4o', 'test-key');
    const events = await collect(provider.runToolsStream({ system: 's', messages: [{ role: 'user', content: 'note hi' }], tools }));

    expect(got).toEqual([{ body: 'hi' }]); // fragments reassembled + parsed
    const action = events.find((e) => e.type === 'action') as { result: unknown } | undefined;
    expect(action?.result).toEqual({ ok: true, summary: 'Saved a note.' });
    const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Saved it.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
