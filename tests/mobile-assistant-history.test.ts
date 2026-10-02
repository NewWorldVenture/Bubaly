import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { Db } from '../mobile/src/lib/db';
import { fetchAssistantConversations, fetchAssistantHistory, mergeAssistantHistory, savedRunIds } from '../mobile/src/lib/assistant-history';

const owner = { userId: 'user-a', familyId: 'family-a' };
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const stamp = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
const rows = Array.from({ length: 205 }, (_, n) => ({ id: id(n), role: n % 2 ? 'assistant' : 'user', content: `Message ${n}`, created_at: stamp(n), structured_content: null, tool_results: null }));
function fixture(options: { inaccessible?: boolean; error?: boolean; messages?: unknown[] } = {}) {
  const calls: URL[] = [];
  const db = createClient('https://fixture.supabase.test', 'synthetic-anon-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = new URL(String(input)); calls.push(url);
    if (options.error) return new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 });
    if (url.pathname.endsWith('/ai_conversations')) {
      if (url.searchParams.get('select') === 'id') return Response.json(options.inaccessible ? [] : [{ id: 'conversation-a' }]);
      return Response.json(Array.from({ length: 26 }, (_, i) => ({ id: id(i), title: `Conversation ${i}`, updated_at: stamp(i) })));
    }
    const before = url.searchParams.get('or')?.match(/created_at\.lt\.([^,]+)/)?.[1];
    return Response.json(options.messages ?? rows.filter((row) => !before || row.created_at < before).reverse().slice(0, 101));
  } } }) as Db;
  return { db, calls, signal: new AbortController().signal };
}

describe('native saved assistant history through the real query builder', () => {
  it('lists only this person’s chats in this family, most recently updated first, with an extra paging sentinel', async () => {
    const { db, calls, signal } = fixture();
    const result = await fetchAssistantConversations(db, owner, signal, 25);
    expect(result.conversations).toHaveLength(25); expect(result.hasMore).toBe(true);
    expect(Object.fromEntries(calls[0].searchParams)).toMatchObject({ user_id: 'eq.user-a', family_id: 'eq.family-a', order: 'updated_at.desc,id.desc', offset: '25', limit: '26' });
  });

  it('opens the latest 100 then all earlier pages chronologically, not the oldest 100', async () => {
    const { db, calls, signal } = fixture();
    const first = await fetchAssistantHistory(db, owner, 'conversation-a', signal);
    expect(first.messages.map((message) => message.content)).toEqual(rows.slice(105).map((row) => row.content));
    expect(first.before).toEqual({ id: id(105), created_at: stamp(105) });
    const second = await fetchAssistantHistory(db, owner, 'conversation-a', signal, first.before!);
    const third = await fetchAssistantHistory(db, owner, 'conversation-a', signal, second.before!);
    const all = mergeAssistantHistory(third.messages, mergeAssistantHistory(second.messages, first.messages));
    expect(all).toHaveLength(205); expect(all.map((message) => message.content)).toEqual(rows.map((row) => row.content));
    expect(third.before).toBeNull();
    expect(Object.fromEntries(calls[0].searchParams)).toMatchObject({ id: 'eq.conversation-a', user_id: 'eq.user-a', family_id: 'eq.family-a' });
    expect(Object.fromEntries(calls[1].searchParams)).toMatchObject({ conversation_id: 'eq.conversation-a', family_id: 'eq.family-a', order: 'created_at.desc,id.desc', limit: '101', role: 'in.(user,assistant)' });
    expect(calls[3].searchParams.get('or')).toContain(`id.lt.${id(105)}`);
  });

  it('does not query messages if ownership is missing and does not treat read errors as empty history', async () => {
    const inaccessible = fixture({ inaccessible: true });
    await expect(fetchAssistantHistory(inaccessible.db, owner, 'other-user-chat', inaccessible.signal)).rejects.toThrow('Conversation unavailable');
    expect(inaccessible.calls).toHaveLength(1);
    const failed = fixture({ error: true });
    await expect(fetchAssistantConversations(failed.db, owner, failed.signal)).rejects.toMatchObject({ message: 'unavailable' });
  });

  it('reopens cards, safe run identifiers, action summaries and partial-response errors', async () => {
    const { db, signal } = fixture({ messages: [{ ...rows[1], tool_results: [{ name: 'create_task', ok: true, summary: 'Task saved' }], structured_content: {
      cards: [{ kind: 'task_group', title: 'Tasks' }], runIds: [id(9), id(9), '../other-page'], responseError: 'Provider stopped after the task was saved.',
    } }] });
    const result = await fetchAssistantHistory(db, owner, 'conversation-a', signal);
    expect(result.messages[0]).toMatchObject({ cards: [{ kind: 'task_group', title: 'Tasks' }], runIds: [id(9)], actions: [{ name: 'create_task', ok: true, summary: 'Task saved' }], responseError: 'Provider stopped after the task was saved.' });
    expect(savedRunIds(['', {}, id(9)])).toEqual([id(9)]);
  });

  it('sorts tied user/assistant rows correctly even across history page boundaries and deduplicates IDs', () => {
    const answer = { id: id(1), created_at: stamp(1), role: 'assistant' as const, content: 'Answer' };
    const question = { id: id(2), created_at: stamp(1), role: 'user' as const, content: 'Question' };
    expect(mergeAssistantHistory([answer, question], [answer])).toEqual([question, answer]);
  });

  it('forwards abort signals and rejects filter-injecting cursors', async () => {
    const { db, calls } = fixture(); const controller = new AbortController(); controller.abort();
    await expect(fetchAssistantHistory(db, owner, 'conversation-a', controller.signal)).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
    await expect(fetchAssistantHistory(db, owner, 'conversation-a', new AbortController().signal, { id: 'bad),id.gt.1', created_at: stamp(1) })).rejects.toThrow('Invalid history cursor');
    expect(calls).toHaveLength(1);
  });
});
