import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createThreadOwner, mergeThreadRows } from '@/lib/messages/thread-state';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { readConversationInbox, readConversationOverview, readMessageWindow } from '@/lib/messages/reads';

type Row = Record<string, unknown>;
const FAMILY = 'synthetic-family';
const THREAD = 'synthetic-thread';
const row = (i: number): Row => ({ id: String(i).padStart(4, '0'), family_id: FAMILY, conversation_id: THREAD, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), content: `Synthetic ${i}`, deleted_at: null, is_pinned: true, kind: 'image' });
type Options = { cap?: number; missingCount?: boolean; changeCount?: boolean; duplicate?: boolean; emptyLater?: boolean; failLater?: boolean; wrongFamily?: boolean; wrongThread?: boolean; invalidTime?: boolean; throwFetch?: boolean; oversized?: boolean };
function fixture(rows: Row[], options: Options = {}) {
  const calls: URL[] = [];
  const client = createClient<Database>('https://messages-sdk-fixture.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input) => {
      const url = new URL(String(input)); calls.push(url);
      if (options.throwFetch) throw new TypeError('Synthetic transport unavailable');
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (offset && options.failLater) return new Response(JSON.stringify({ code: '42501', message: 'Synthetic later page refused' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      let eligible = [...rows];
      const filter = url.searchParams.get('or');
      if (filter) {
        const time = filter.match(/created_at[.]lt[.]([^,]+)/)?.[1] ?? '';
        const id = filter.match(/id[.](lt|lte)[.]([^)]*)/);
        eligible = eligible.filter(r => String(r.created_at) < time || r.created_at === time && id && (id[1] === 'lte' ? String(r.id) <= id[2] : String(r.id) < id[2]));
      }
      if (url.searchParams.get('deleted_at') === 'is.null') eligible = eligible.filter(r => r.deleted_at === null);
      if (url.searchParams.get('is_pinned') === 'eq.true') eligible = eligible.filter(r => r.is_pinned === true);
      if (url.searchParams.get('kind') === 'eq.image') eligible = eligible.filter(r => r.kind === 'image');
      const order = (url.searchParams.get('order') ?? '').split(',').filter(Boolean);
      eligible.sort((a, b) => {
        for (const rule of order) {
          const [key, direction, nulls] = rule.split('.');
          if (a[key] == null || b[key] == null) { if (a[key] == null && b[key] == null) continue; return a[key] == null ? (nulls === 'nullslast' ? 1 : -1) : (nulls === 'nullslast' ? -1 : 1); }
          const compare = String(a[key]).localeCompare(String(b[key])); if (compare) return direction === 'desc' ? -compare : compare;
        } return 0;
      });
      let page = eligible.slice(options.duplicate && offset ? 0 : offset, (options.duplicate && offset ? 0 : offset) + Math.min(Number(url.searchParams.get('limit') ?? 1000), options.cap ?? 1000));
      if (offset && options.emptyLater) page = [];
      if (options.wrongFamily) page = page.map(r => ({ ...r, family_id: 'other-family' }));
      if (options.wrongThread) page = page.map(r => ({ ...r, conversation_id: 'other-thread' }));
      if (options.invalidTime) page = page.map(r => ({ ...r, created_at: 'invalid' }));
      const count = options.oversized ? 10_001 : eligible.length + (offset && options.changeCount ? 1 : 0);
      return new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json', ...(options.missingCount ? {} : { 'Content-Range': `${offset}-${Math.max(offset, offset + page.length - 1)}/${count}` }) } });
    } },
  });
  return { client, calls };
}

describe('complete messaging reads through the actual Supabase SDK', () => {
  it('completes exactly the newest 51 of 60 messages despite cap2, with explicit family/thread filters and ID tie order', async () => {
    const { client, calls } = fixture(Array.from({ length: 60 }, (_, i) => row(i)), { cap: 2 });
    const result = await readMessageWindow(client, FAMILY, THREAD);
    expect(result.error).toBeNull(); expect(result.data).toHaveLength(51);
    expect(result.data?.[0].id).toBe('0059'); expect(result.data?.at(-1)?.id).toBe('0009');
    expect(calls).toHaveLength(26);
    for (const call of calls) { expect(call.searchParams.get('family_id')).toBe(`eq.${FAMILY}`); expect(call.searchParams.get('conversation_id')).toBe(`eq.${THREAD}`); expect(call.searchParams.get('order')).toBe('created_at.desc,id.desc'); }
    expect(calls.at(-1)?.searchParams.get('limit')).toBe('1');
  });
  it('continues from an exclusive equal-time ID cursor without skips', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ ...row(i), created_at: '2026-01-01T00:00:00.000Z' }));
    const { client } = fixture(rows, { cap: 2 });
    const result = await readMessageWindow(client, FAMILY, THREAD, { cursor: { id: '0004', created_at: String(rows[0].created_at) } });
    expect(result.error).toBeNull(); expect(result.data?.map(r => r.id)).toEqual(['0003', '0002', '0001', '0000']);
  });
  it('includes the selected jump message and bounds its older window', async () => {
    const { client } = fixture(Array.from({ length: 60 }, (_, i) => row(i)), { cap: 2 });
    const result = await readMessageWindow(client, FAMILY, THREAD, { cursor: row(40) as { id: string; created_at: string }, inclusive: true, take: 5 });
    expect(result.error).toBeNull(); expect(result.data?.map(r => r.id)).toEqual(['0040', '0039', '0038', '0037', '0036']);
  });
  for (const kind of ['photos', 'pinned'] as const) it(`completes the ${kind} gallery while excluding deleted and unrelated kinds`, async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ ...row(i), deleted_at: i === 7 ? '2026-01-02' : null, is_pinned: i !== 6, kind: i === 6 ? 'text' : 'image' }));
    const { client, calls } = fixture(rows, { cap: 2 });
    const result = await readMessageWindow(client, FAMILY, THREAD, { kind });
    expect(result.error).toBeNull(); expect(result.data).toHaveLength(6);
    expect(calls.every(c => c.searchParams.get('deleted_at') === 'is.null')).toBe(true);
  });
  it('completes the scoped inbox before selecting an older canonical Family Chat', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: String(i), family_id: FAMILY, is_family_chat: i === 0, last_message_at: i === 0 ? null : '2026-01-01' }));
    const { client, calls } = fixture(rows, { cap: 2 });
    const result = await readConversationInbox(client, FAMILY);
    expect(result.error).toBeNull(); expect(result.data?.map(r => r.id)).toEqual(['4', '3', '2', '1', '0']);
    expect(result.data?.at(-1)?.is_family_chat).toBe(true);
    expect(calls.every(c => c.searchParams.get('family_id') === `eq.${FAMILY}`)).toBe(true);
  });
  it('completes exact-count RPC summaries, preserving a late unread badge', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ conversation_id: `thread-${i}`, last_message: null, unread_count: i }));
    const { client, calls } = fixture(rows, { cap: 2 });
    const result = await readConversationOverview(client, FAMILY);
    expect(result.error).toBeNull(); expect(result.data).toHaveLength(5); expect(result.data?.at(-1)?.unread_count).toBe(4);
    expect(calls.every(c => c.pathname.endsWith('/rpc/family_conversation_overview') && c.searchParams.get('order') === 'conversation_id.asc')).toBe(true);
  });
  for (const options of [{ missingCount: true }, { cap: 2, changeCount: true }, { cap: 2, duplicate: true }, { cap: 2, emptyLater: true }, { cap: 2, failLater: true }, { wrongFamily: true }, { wrongThread: true }, { invalidTime: true }, { throwFetch: true }] satisfies Options[]) {
    it(`refuses partial or invalid message history: ${JSON.stringify(options)}`, async () => {
      const { client } = fixture(Array.from({ length: 6 }, (_, i) => row(i)), options);
      const result = await readMessageWindow(client, FAMILY, THREAD);
      expect(result.data).toBeNull(); expect(result.error?.message).toBeTruthy();
    });
  }
  it('refuses an over-bound inbox rather than a prefix', async () => {
    const { client } = fixture([{ id: 'one', family_id: FAMILY }], { oversized: true });
    const result = await readConversationInbox(client, FAMILY);
    expect(result.data).toBeNull(); expect(result.error?.details).toContain('safe read bound');
  });
  it('rejects a foreign last-message payload in the overview', async () => {
    const { client } = fixture([{ conversation_id: THREAD, last_message: { ...row(0), family_id: 'other' }, unread_count: 1 }]);
    const result = await readConversationOverview(client, FAMILY);
    expect(result.data).toBeNull(); expect(result.error).toBeTruthy();
  });
  for (const count of [null, '', ' ', false, -1, 'NaN', '2bad', 1.5]) it(`refuses malformed unread count ${JSON.stringify(count)}`, async () => {
    const { client } = fixture([{ conversation_id: THREAD, last_message: null, unread_count: count }]);
    const result = await readConversationOverview(client, FAMILY);
    expect(result.data).toBeNull(); expect(result.error).toBeTruthy();
  });
  it('accepts a nonnegative decimal-string unread count with nullable last message', async () => {
    const { client } = fixture([{ conversation_id: THREAD, last_message: null, unread_count: '12' }]);
    const result = await readConversationOverview(client, FAMILY);
    expect(result.error).toBeNull(); expect(result.data?.[0].unread_count).toBe('12');
  });
  for (const lastMessage of [false, 0, '']) it(`refuses malformed falsy last-message payload ${JSON.stringify(lastMessage)}`, async () => {
    const { client } = fixture([{ conversation_id: THREAD, last_message: lastMessage, unread_count: 0 }]);
    const result = await readConversationOverview(client, FAMILY);
    expect(result.data).toBeNull(); expect(result.error).toBeTruthy();
  });
  it('accepts confirmed empty scoped collections', async () => {
    const { client } = fixture([]);
    for (const result of await Promise.all([readConversationInbox(client, FAMILY), readConversationOverview(client, FAMILY), readMessageWindow(client, FAMILY, THREAD)])) { expect(result.error).toBeNull(); expect(result.data).toEqual([]); }
  });
  it('refuses invalid scopes and cursors before any network request', async () => {
    const { client, calls } = fixture([]);
    const results = await Promise.all([readConversationInbox(client, ''), readConversationOverview(client, ''), readMessageWindow(client, FAMILY, ''), readMessageWindow(client, FAMILY, THREAD, { take: 0 }), readMessageWindow(client, FAMILY, THREAD, { cursor: { id: '', created_at: 'not-a-date' } })]);
    expect(results.every(r => r.data === null && r.error)).toBe(true); expect(calls).toHaveLength(0);
  });
});


describe('actual rendered-origin jump callback with the real SDK', () => {
  function callbackFixture() {
    const source = readFileSync('components/modules/messages-module.tsx', 'utf8');
    const start = source.indexOf('  const jumpOrigin = owner.current.capture();');
    const end = source.indexOf('  async function archiveConversation(', start);
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
    const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const sdk = fixture(Array.from({ length: 8 }, (_, i) => row(i)), { cap: 2 });
    const ownership = createThreadOwner(); ownership.select(THREAD);
    const published: unknown[] = [], stateChanges: string[] = [];
    const env = { owner: { current: ownership }, alive: { current: true }, familyId: FAMILY,
      setThreadSearch: () => stateChanges.push('search'), setShowAbout: () => stateChanges.push('about'),
      messagesRef: { current: [] }, readMessageWindow, createClient: () => sdk.client, PAGE_SIZE: 50,
      toastError: () => stateChanges.push('toast'), describeDbError: String, setMessages: (rows: unknown) => published.push(rows),
      mergeThreadRows, setViewingHistory: () => stateChanges.push('history'), historyRef: { current: false },
      setHasOlder: () => stateChanges.push('older'), requestAnimationFrame: () => {},
    };
    const jump = new Function(...Object.keys(env), js + ';return jumpToMessage;')(...Object.values(env)) as (message: Row) => Promise<void>;
    return { ...sdk, ownership, published, stateChanges, env, jump };
  }
  for (const retirement of ['other-thread', 'same-thread-ABA', 'unmount', 'foreign-family', 'foreign-thread']) it(`rejects ${retirement} before query or state changes`, async () => {
    const test = callbackFixture(), message = row(5);
    if (retirement === 'other-thread') test.ownership.select('other');
    if (retirement === 'same-thread-ABA') { test.ownership.select('other'); test.ownership.select(THREAD); }
    if (retirement === 'unmount') test.env.alive.current = false;
    if (retirement === 'foreign-family') message.family_id = 'other';
    if (retirement === 'foreign-thread') message.conversation_id = 'other';
    await test.jump(message);
    expect(test.calls).toHaveLength(0); expect(test.published).toEqual([]); expect(test.stateChanges).toEqual([]);
  });
  it('retains a legitimate current-origin jump and completes its capped history', async () => {
    const test = callbackFixture(); await test.jump(row(5));
    expect(test.calls).toHaveLength(3); expect(test.published).toHaveLength(1);
    expect((test.published[0] as Row[]).map(r => r.id)).toEqual(['0000', '0001', '0002', '0003', '0004', '0005']);
    expect(test.stateChanges).toContain('history');
  });
});
