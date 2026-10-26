import { describe, expect, it, vi } from 'vitest';
import {
  AssistantConversationActivity, assistantConversationKey, chronologicalMessages,
  consumeAssistantStream, readAssistantConversation, rememberAssistantConversation,
} from '@/lib/ai/conversation-session';
import { structuredContentFrom, toStructuredContent } from '@/lib/ai/result-cards';

describe('assistant conversation ownership', () => {
  it('partitions remembered conversations by both person and household and tolerates unavailable storage', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const id = '11111111-1111-4111-8111-111111111111';
    values.set('assistant-conv-id', id);
    const key = assistantConversationKey('person-A', 'family-A');
    expect(readAssistantConversation(storage, key)).toBeNull();
    rememberAssistantConversation(storage, key, id);
    expect(readAssistantConversation(storage, key)).toBe(id);
    expect(readAssistantConversation(storage, assistantConversationKey('person-B', 'family-A'))).toBeNull();
    expect(readAssistantConversation(storage, assistantConversationKey('person-A', 'family-B'))).toBeNull();
    values.set(key, 'not-a-valid-id'); expect(readAssistantConversation(storage, key)).toBeNull();
    expect(readAssistantConversation({ getItem() { throw new Error('Storage denied'); } }, key)).toBeNull();
    expect(() => rememberAssistantConversation({ setItem() { throw new Error('Storage denied'); } }, key, id)).not.toThrow();
  });

  it('retires pending requests and even completed-but-queued updaters when the selected thread changes', () => {
    const activity = new AssistantConversationActivity();
    const request = activity.begin();
    const completed = activity.begin(); completed.finish();
    expect(request.current()).toBe(true);
    activity.invalidate();
    expect(request.controller.signal.aborted).toBe(true);
    expect(request.current()).toBe(false);
    expect(completed.current()).toBe(false);
    const next = activity.begin(); expect(next.current()).toBe(true);
    activity.dispose(); expect(next.current()).toBe(false);
    activity.activate(); expect(next.current()).toBe(false);
    expect(activity.begin().current()).toBe(true);
  });

  it('renders a same-timestamp persisted question before its answer without mutating the query result', () => {
    const rows = [
      { role: 'assistant', content: 'New answer', created_at: '2026-10-02T02:00:00Z' },
      { role: 'user', content: 'New question', created_at: '2026-10-02T02:00:00Z' },
      { role: 'assistant', content: 'Old answer', created_at: '2026-10-02T01:00:00Z' },
      { role: 'user', content: 'Old question', created_at: '2026-10-02T01:00:00Z' },
    ];
    expect(chronologicalMessages(rows).map(row => row.content)).toEqual(['Old question', 'Old answer', 'New question', 'New answer']);
    expect(rows[0].content).toBe('New answer');
  });
});

describe('assistant response transport', () => {
  it('rehydrates the incomplete-answer warning alongside preserved run links', () => {
    const saved = toStructuredContent([], ['run-1'], 'The response was interrupted.');
    expect(structuredContentFrom(JSON.parse(JSON.stringify(saved)))).toEqual({
      cards: [], runIds: ['run-1'], responseError: 'The response was interrupted.',
    });
  });
  it('decodes split Unicode, CRLF, multiline data and the terminal frame without its final delimiter', async () => {
    const wire = new TextEncoder().encode('data: {"type":"delta",\r\ndata: "text":"Olá 👋"}\r\n\r\ndata: {"type":"error","error":"Not saved"}\n\ndata: {"type":"done","content":"Olá 👋","persisted":false}');
    const events: unknown[] = [];
    const result = await consumeAssistantStream(new ReadableStream({ start(controller) { for (const byte of wire) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), event => events.push(event));
    expect(result.completed).toBe(true);
    // A done event always carries its turn's request id (F19), null when the
    // server sent none.
    expect(events).toEqual([{ type: 'delta', text: 'Olá 👋' }, { type: 'error', error: 'Not saved' }, { type: 'done', content: 'Olá 👋', persisted: false, requestId: null }]);
  });

  it('does not mistake transport EOF for successfully completed generation', async () => {
    const onEvent = vi.fn();
    const result = await consumeAssistantStream(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"delta","text":"Partial"}\n\n')); controller.close(); } }), onEvent);
    expect(onEvent).toHaveBeenCalledWith({ type: 'delta', text: 'Partial' });
    expect(result.completed).toBe(false);
  });

  it('cancels a held reader and never delivers buffered events after its owner is retired', async () => {
    const abort = new AbortController(); const cancel = vi.fn(); const onEvent = vi.fn();
    const result = consumeAssistantStream(new ReadableStream({ cancel }), onEvent, abort.signal);
    abort.abort();
    expect(await result).toEqual({ completed: false });
    expect(cancel).toHaveBeenCalledOnce(); expect(onEvent).not.toHaveBeenCalled();
  });
});
