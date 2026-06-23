import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAIProvider, type ToolSpec } from '@/lib/ai/provider';

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('OpenAIProvider.runTools — agentic tool loop', () => {
  it('executes a requested tool, feeds the result back, and returns the final reply', async () => {
    const fetchMock = vi.fn()
      // Round 1: model asks to call add_note
      .mockReturnValueOnce(jsonResponse({
        choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add_note', arguments: '{"body":"Buy milk"}' } }] } }],
      }))
      // Round 2: model produces the final natural-language reply
      .mockReturnValueOnce(jsonResponse({
        choices: [{ message: { content: 'Saved that note for you.' } }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const executed: Record<string, unknown>[] = [];
    const tools: ToolSpec[] = [{
      name: 'add_note',
      description: 'save a note',
      input_schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
      execute: async (args) => { executed.push(args); return { ok: true, summary: 'Saved a note.' }; },
    }];

    const provider = new OpenAIProvider('gpt-4o', 'test-key');
    const result = await provider.runTools({ system: 'sys', messages: [{ role: 'user', content: 'note: buy milk' }], tools });

    expect(executed).toEqual([{ body: 'Buy milk' }]);          // tool actually ran with parsed args
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].name).toBe('add_note');
    expect(result.actions[0].result).toEqual({ ok: true, summary: 'Saved a note.' });
    expect(result.text).toBe('Saved that note for you.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the reply directly when no tool is called', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(jsonResponse({
      choices: [{ message: { content: 'Your week looks light.' } }],
    })));
    const provider = new OpenAIProvider('gpt-4o', 'test-key');
    const result = await provider.runTools({ system: 'sys', messages: [{ role: 'user', content: 'how is my week?' }], tools: [] });
    expect(result.text).toBe('Your week looks light.');
    expect(result.actions).toEqual([]);
  });

  it('records a tool error instead of throwing', async () => {
    const fetchMock = vi.fn()
      .mockReturnValueOnce(jsonResponse({ choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'add_note', arguments: '{}' } }] } }] }))
      .mockReturnValueOnce(jsonResponse({ choices: [{ message: { content: 'Hmm, that failed.' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const tools: ToolSpec[] = [{
      name: 'add_note', description: 'x', input_schema: { type: 'object' },
      execute: async () => { throw new Error('db down'); },
    }];
    const provider = new OpenAIProvider('gpt-4o', 'test-key');
    const result = await provider.runTools({ system: 's', messages: [{ role: 'user', content: 'x' }], tools });
    expect(result.actions[0].result).toEqual({ ok: false, error: 'db down' });
  });
});
