// The messages workspace on production's schema, which has not taken 0475.
//
// Owner decision: until 0475_messaging_conversation_privacy_and_delivery.sql
// is applied, each path the workspace loads or writes through does what the
// previous production build (82f2db1) did, and the new path runs unchanged
// once the object exists. Only PostgREST's exact missing-object answer naming
// that object selects a fallback; any other error is still the module's error.
//
// These drive the functions MessagesModule calls (lib/messages/workspace-paths)
// against one in-memory PostgREST stand-in, with and without 0475. The module
// toasts exactly when one of them returns an error, so "no error" here is "no
// error toast" there.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import {
  createFamilyConversation, ensureFamilyChat, familyChatOf, loadConversationSummaries, loadInbox,
  markConversationReadThrough, toggleMessageReaction,
} from '@/lib/messages/workspace-paths';
import { resetMissingMigrationWarnings } from '@/lib/messages/schema-compat';

type Row = Record<string, unknown>;
type Err = { code?: string; message: string; details?: string | null; hint?: string | null };
type Call = { kind: 'rpc' | 'select' | 'insert' | 'update'; name: string; args?: unknown };

const FAMILY = 'fam-1';
const ME = 'user-me';
const OTHER = 'user-other';
const ME_MEMBER = 'member-me';
const RPCS_0475 = ['ensure_family_conversation', 'create_family_conversation', 'family_conversation_overview',
  'mark_conversation_read_through', 'toggle_family_message_reaction'];

/** PostgREST's answer for a function the schema cache does not have. */
const missingFunction = (name: string, args: Row): Err => ({
  code: 'PGRST202',
  message: `Could not find the function public.${name}(${Object.keys(args).join(', ')}) in the schema cache`,
  details: 'Searched for the function with the given parameters, but no matches were found in the schema cache.',
  hint: null,
});

function conversation(id: string, extra: Row = {}, has0475 = true): Row {
  const row: Row = {
    id, family_id: FAMILY, name: id, kind: 'group', avatar_emoji: '💬', description: null, is_archived: false,
    member_ids: [ME, OTHER], participant_ids: [ME_MEMBER, 'member-other'], created_by: ME,
    last_message_at: '2026-10-02T12:00:00Z', created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-02T12:00:00Z',
    is_family_chat: false, ...extra,
  };
  if (!has0475) delete row.is_family_chat;
  return row;
}

function message(id: string, conversationId: string, extra: Row = {}): Row {
  return {
    id, family_id: FAMILY, conversation_id: conversationId, sender_id: OTHER, sender_name: 'Blair', sender_avatar: null,
    content: `text ${id}`, kind: 'text', attachment_url: null, attachment_name: null, attachment_mime: null,
    reply_to_id: null, reactions: {}, read_by: [], is_pinned: false, deleted_at: null,
    created_at: `2026-10-02T12:0${id.slice(-1)}:00Z`, ...extra,
  };
}

/** A small PostgREST: equality filters, ordering, windows, counts, writes, and RPCs by schema. */
function memoryDb(options: { has0475: boolean; conversations: Row[]; messages: Row[]; rpcErrors?: Record<string, Err>; insertErrors?: Err[]; selectErrors?: Record<string, Err> }) {
  const tables: Record<string, Row[]> = { family_conversations: options.conversations, family_messages: options.messages };
  const calls: Call[] = [];
  const insertErrors = [...(options.insertErrors ?? [])];
  let nextId = 1;

  function from(table: string) {
    let action: 'select' | 'insert' | 'update' = 'select';
    let payload: Row | null = null;
    let columns = '*';
    const filters: [string, unknown][] = [];
    const order: [string, boolean][] = [];
    let offset = 0;
    let limit = Infinity;
    let single = false;
    const execute = async (): Promise<{ data: unknown; count: number | null; error: Err | null }> => {
      calls.push({ kind: action, name: table, args: payload ?? Object.fromEntries(filters) });
      const rows = tables[table] ?? [];
      if (action === 'insert') {
        const failure = insertErrors.shift();
        if (failure) return { data: null, count: null, error: failure };
        const row = { ...conversation(`created-${nextId++}`, {}, options.has0475), ...payload };
        rows.push(row);
        return { data: single ? row : [row], count: null, error: null };
      }
      let selected = rows.filter((row) => filters.every(([key, value]) => (row[key] ?? null) === value));
      if (action === 'update') {
        for (const row of selected) Object.assign(row, payload);
        return { data: selected.map((row) => ({ ...row })), count: null, error: null };
      }
      if (options.selectErrors?.[table]) return { data: null, count: null, error: options.selectErrors[table] };
      if (!options.has0475 && /is_family_chat/.test(columns)) {
        return { data: null, count: null, error: { code: '42703', message: `column ${table}.is_family_chat does not exist` } };
      }
      selected = [...selected].sort((a, b) => {
        for (const [key, ascending] of order) {
          const n = String(a[key]).localeCompare(String(b[key]));
          if (n) return ascending ? n : -n;
        }
        return 0;
      });
      const count = selected.length;
      const page = selected.slice(offset, offset + limit).map((row) => JSON.parse(JSON.stringify(row)) as Row);
      return { data: single ? page[0] ?? null : page, count, error: null };
    };
    const q: Record<string, unknown> = {
      select: (value = '*') => { columns = value; return q; },
      eq: (key: string, value: unknown) => { filters.push([key, value]); return q; },
      is: (key: string, value: unknown) => { filters.push([key, value]); return q; },
      order: (key: string, opts?: { ascending?: boolean }) => { order.push([key, opts?.ascending !== false]); return q; },
      limit: (n: number) => { limit = n; return q; },
      range: (a: number, b: number) => { offset = a; limit = b - a + 1; return q; },
      insert: (value: Row) => { action = 'insert'; payload = value; return q; },
      update: (value: Row) => { action = 'update'; payload = value; return q; },
      single: () => { single = true; return execute(); },
      maybeSingle: () => { single = true; return execute(); },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => execute().then(resolve, reject),
    };
    return q;
  }

  function answer(name: string, args: Row): { data: unknown; error: Err | null } {
    if (options.rpcErrors?.[name]) return { data: null, error: options.rpcErrors[name] };
    if (!options.has0475 && RPCS_0475.includes(name)) return { data: null, error: missingFunction(name, args) };
    const convs = tables.family_conversations;
    const msgs = tables.family_messages;
    switch (name) {
      case 'mark_conversation_read': // 0163, on both schemas
      case 'mark_conversation_read_through':
        for (const row of msgs) if (row.conversation_id === args.p_conversation_id) row.read_by = [...new Set([...(row.read_by as string[]), ME])];
        return { data: name === 'mark_conversation_read' ? null : 1, error: null };
      case 'ensure_family_conversation': {
        let chat = convs.find((row) => row.is_family_chat);
        if (!chat) { chat = conversation('canonical', { is_family_chat: true, name: 'Family Chat' }); convs.push(chat); }
        return { data: chat.id, error: null };
      }
      case 'create_family_conversation': {
        const row = conversation(`rpc-${nextId++}`, { name: args.p_name, kind: args.p_kind, participant_ids: args.p_participant_ids });
        convs.push(row);
        return { data: row, error: null };
      }
      case 'toggle_family_message_reaction': {
        const row = msgs.find((m) => m.id === args.p_message_id)!;
        const reactions = row.reactions as Record<string, string[]>;
        row.reactions = { ...reactions, [args.p_emoji as string]: [...(reactions[args.p_emoji as string] ?? []), ME] };
        return { data: { ...row }, error: null };
      }
      case 'family_conversation_overview':
        return {
          data: convs.map((conv) => {
            const rows = msgs.filter((m) => m.conversation_id === conv.id);
            return { conversation_id: conv.id, last_message: rows.at(-1) ?? null, unread_count: rows.filter((m) => !(m.read_by as string[]).includes(ME)).length };
          }).sort((a, b) => String(a.conversation_id).localeCompare(String(b.conversation_id))),
          error: null,
        };
      default:
        throw new Error(`Unexpected RPC ${name}`);
    }
  }

  function rpc(name: string, args: Row = {}) {
    let offset = 0;
    let limit = Infinity;
    const run = async () => {
      calls.push({ kind: 'rpc', name, args });
      const { data, error } = answer(name, args);
      if (error || !Array.isArray(data)) return { data, count: null, error };
      return { data: data.slice(offset, offset + limit), count: data.length, error: null };
    };
    const q: Record<string, unknown> = {
      order: () => q,
      limit: (n: number) => { limit = n; return q; },
      range: (a: number, b: number) => { offset = a; limit = b - a + 1; return q; },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => run().then(resolve, reject),
    };
    return q;
  }

  return { db: { from, rpc } as unknown as SupabaseClient<Database>, calls, tables };
}

const MEMBERS = [{ id: ME_MEMBER, user_id: ME }, { id: 'member-kid', user_id: null }];
const asMessage = (row: Row) => row as unknown as Tables<'family_messages'>;

function seed(has0475: boolean) {
  return {
    conversations: [
      conversation('dm-with-blair', { kind: 'direct', name: 'Blair DM', participant_ids: [ME_MEMBER, 'member-other'] }, has0475),
      conversation('family-group', { name: 'Family Chat', is_family_chat: has0475 }, has0475),
      conversation('someone-elses-group', { member_ids: [OTHER], participant_ids: ['member-other'], created_by: OTHER, last_message_at: '2026-09-30T12:00:00Z' }, has0475),
    ],
    messages: [message('m-1', 'family-group'), message('m-2', 'family-group'), message('m-3', 'dm-with-blair', { read_by: [ME] })],
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { resetMissingMigrationWarnings(); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('without 0475 the workspace behaves as the previous production build', () => {
  it('lists every existing conversation and opens the old family group, with no error to toast', async () => {
    const { db } = memoryDb({ has0475: false, ...seed(false) });
    const inbox = await loadInbox(db, { familyId: FAMILY, userId: ME, selfMemberId: ME_MEMBER });
    expect(inbox.error).toBeNull();
    expect(inbox.legacy).toBe(true);
    // Every row the family-wide read returns, as 82f2db1 listed them.
    expect(inbox.rows?.map((row) => row.id).sort()).toEqual(['dm-with-blair', 'family-group', 'someone-elses-group']);
    // The first group that is not a DM in the inbox's order, as 82f2db1 opened.
    expect(familyChatOf(inbox.rows!, inbox.legacy)?.id).toBe('family-group');
    expect(String(warn.mock.calls[0]?.[0])).toContain('0475_messaging_conversation_privacy_and_delivery.sql');
  });

  it('ensures the family chat by looking up the group chat, and creates one only when there is none', async () => {
    const existing = memoryDb({ has0475: false, ...seed(false) });
    expect(await ensureFamilyChat(existing.db, { familyId: FAMILY, userId: ME, name: 'Family Chat', members: MEMBERS }))
      .toEqual({ error: null, legacy: true });
    expect(existing.calls.filter((c) => c.kind === 'insert')).toEqual([]);

    const empty = memoryDb({ has0475: false, conversations: [], messages: [] });
    expect(await ensureFamilyChat(empty.db, { familyId: FAMILY, userId: ME, name: 'Family Chat', members: MEMBERS }))
      .toEqual({ error: null, legacy: true });
    expect(empty.calls.filter((c) => c.kind === 'insert')).toEqual([{ kind: 'insert', name: 'family_conversations', args: {
      family_id: FAMILY, name: 'Family Chat', kind: 'group', avatar_emoji: '👨‍👩‍👧‍👦', created_by: ME,
      member_ids: [ME], participant_ids: [ME_MEMBER, 'member-kid'],
    } }]);
  });

  it('computes previews and unread badges from the bounded message scan', async () => {
    const { db, calls } = memoryDb({ has0475: false, ...seed(false) });
    const { data, error } = await loadConversationSummaries(db, { familyId: FAMILY, userId: ME });
    expect(error).toBeNull();
    expect(Object.fromEntries(data!.unreadByConv)).toEqual({ 'family-group': 2 });
    expect(data!.lastByConv.get('family-group')?.content).toBe('text m-2');
    expect(data!.lastByConv.get('dm-with-blair')?.content).toBe('text m-3');
    expect(calls.find((c) => c.kind === 'select' && c.name === 'family_messages')?.args).toEqual({ family_id: FAMILY, deleted_at: null });
  });

  it("marks read through 0163's mark_conversation_read", async () => {
    const { db, calls, tables } = memoryDb({ has0475: false, ...seed(false) });
    const rows = tables.family_messages.filter((m) => m.conversation_id === 'family-group').map(asMessage);
    expect(await markConversationReadThrough(db, { conversationId: 'family-group', messageId: 'm-2', familyId: FAMILY, userId: ME, rows }))
      .toEqual({ error: null, legacy: true });
    expect(calls.filter((c) => c.kind === 'rpc').map((c) => c.name)).toEqual(['mark_conversation_read_through', 'mark_conversation_read']);
    expect(tables.family_messages.filter((m) => m.conversation_id === 'family-group').every((m) => (m.read_by as string[]).includes(ME))).toBe(true);
  });

  it('falls back per row when mark_conversation_read itself fails, appending only the reader', async () => {
    const { db, calls, tables } = memoryDb({ has0475: false, ...seed(false), rpcErrors: { mark_conversation_read: { code: '42501', message: 'permission denied' } } });
    tables.family_messages[0].read_by = [OTHER];
    const rows = tables.family_messages.filter((m) => m.conversation_id === 'family-group').map(asMessage);
    expect((await markConversationReadThrough(db, { conversationId: 'family-group', messageId: 'm-2', familyId: FAMILY, userId: ME, rows })).error).toBeNull();
    expect(calls.filter((c) => c.kind === 'update').map((c) => c.args)).toEqual([{ read_by: [OTHER, ME] }, { read_by: [ME] }]);
  });

  it('toggles a reaction by updating the message', async () => {
    const { db, calls } = memoryDb({ has0475: false, ...seed(false) });
    const result = await toggleMessageReaction(db, { message: asMessage(message('m-1', 'family-group')), emoji: '👍', userId: ME, familyId: FAMILY });
    expect(result).toMatchObject({ error: null, legacy: true, data: { id: 'm-1', reactions: { '👍': [ME] } } });
    expect(calls.find((c) => c.kind === 'update')?.args).toEqual({ reactions: { '👍': [ME] } });
  });

  it('creates a conversation by direct insert, retrying without participant_ids on a pre-0017 schema', async () => {
    const payload = { family_id: FAMILY, name: 'Blair', kind: 'direct', avatar_emoji: null, created_by: ME, member_ids: [ME, OTHER], participant_ids: [ME_MEMBER, 'member-other'] };
    const direct = memoryDb({ has0475: false, conversations: [], messages: [] });
    const created = await createFamilyConversation(direct.db, payload);
    expect(created.error).toBeNull();
    expect(direct.calls.filter((c) => c.kind === 'insert').map((c) => c.args)).toEqual([payload]);

    const pre0017 = memoryDb({ has0475: false, conversations: [], messages: [], insertErrors: [
      { code: 'PGRST204', message: "Could not find the 'participant_ids' column of 'family_conversations' in the schema cache" }] });
    expect((await createFamilyConversation(pre0017.db, payload)).error).toBeNull();
    const { participant_ids: _dropped, ...withoutParticipants } = payload;
    expect(pre0017.calls.filter((c) => c.kind === 'insert').map((c) => c.args)).toEqual([payload, withoutParticipants]);
  });

  it('reuses an existing 1:1 chat with the same person instead of inserting a duplicate', async () => {
    const payload = { family_id: FAMILY, name: 'Blair', kind: 'direct', avatar_emoji: null, created_by: ME, member_ids: [ME, OTHER], participant_ids: ['member-other', ME_MEMBER] };
    const { db, calls } = memoryDb({ has0475: false, ...seed(false) });
    const reused = await createFamilyConversation(db, payload);
    expect(reused).toMatchObject({ error: null, data: { id: 'dm-with-blair' } });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
    expect(calls.find((c) => c.kind === 'select')?.args).toEqual({ family_id: FAMILY, kind: 'direct' });

    // A second DM to the same person on the old schema: the first one again.
    const fresh = memoryDb({ has0475: false, conversations: [], messages: [] });
    const first = await createFamilyConversation(fresh.db, payload);
    const second = await createFamilyConversation(fresh.db, payload);
    expect(second.data?.id).toBe(first.data?.id);
    expect(fresh.calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
  });

  it('matches a DM recorded before participant ids on its account holders, and a different person gets a new chat', async () => {
    const { db, calls } = memoryDb({ has0475: false, conversations: [
      conversation('old-dm', { kind: 'direct', member_ids: [OTHER, ME], participant_ids: [] }, false),
    ], messages: [] });
    const base = { family_id: FAMILY, name: 'Blair', kind: 'direct', avatar_emoji: null, created_by: ME };
    expect((await createFamilyConversation(db, { ...base, member_ids: [ME, OTHER], participant_ids: [ME_MEMBER, 'member-other'] })).data?.id).toBe('old-dm');
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
    const other = await createFamilyConversation(db, { ...base, member_ids: [ME], participant_ids: [ME_MEMBER, 'member-kid'] });
    expect(other.error).toBeNull();
    expect(other.data?.id).not.toBe('old-dm');
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
  });

  it('a failed DM lookup is the error and inserts nothing', async () => {
    const denied: Err = { code: '42501', message: 'permission denied for table family_conversations' };
    const { db, calls } = memoryDb({ has0475: false, ...seed(false), selectErrors: { family_conversations: denied } });
    const res = await createFamilyConversation(db, { family_id: FAMILY, name: 'Blair', kind: 'direct', avatar_emoji: null, created_by: ME, member_ids: [ME, OTHER], participant_ids: [ME_MEMBER, 'member-other'] });
    expect(res).toEqual({ data: null, error: denied });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it('warns once per missing object, naming the migration', async () => {
    const { db } = memoryDb({ has0475: false, ...seed(false) });
    await loadConversationSummaries(db, { familyId: FAMILY, userId: ME });
    await loadConversationSummaries(db, { familyId: FAMILY, userId: ME });
    const overview = warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('family_conversation_overview'));
    expect(overview).toHaveLength(1);
    expect(String(overview[0][0])).toContain('0475_messaging_conversation_privacy_and_delivery.sql');
  });
});

describe('with 0475 every path is the new one, unchanged', () => {
  it('lists only the conversations this viewer belongs to and opens the canonical chat', async () => {
    const { db } = memoryDb({ has0475: true, ...seed(true) });
    const inbox = await loadInbox(db, { familyId: FAMILY, userId: ME, selfMemberId: ME_MEMBER });
    expect(inbox).toMatchObject({ error: null, legacy: false });
    expect(inbox.rows?.map((row) => row.id).sort()).toEqual(['dm-with-blair', 'family-group']);
    expect(familyChatOf(inbox.rows!, inbox.legacy)?.id).toBe('family-group');
  });

  it('uses the RPCs and never the old direct writes', async () => {
    const { db, calls, tables } = memoryDb({ has0475: true, ...seed(true) });
    expect(await ensureFamilyChat(db, { familyId: FAMILY, userId: ME, name: 'Family Chat', members: MEMBERS })).toEqual({ error: null, legacy: false });
    const summaries = await loadConversationSummaries(db, { familyId: FAMILY, userId: ME });
    expect(Object.fromEntries(summaries.data!.unreadByConv)).toEqual({ 'dm-with-blair': 0, 'family-group': 2, 'someone-elses-group': 0 });
    const rows = tables.family_messages.map(asMessage);
    expect(await markConversationReadThrough(db, { conversationId: 'family-group', messageId: 'm-2', familyId: FAMILY, userId: ME, rows })).toEqual({ error: null, legacy: false });
    expect((await toggleMessageReaction(db, { message: rows[0], emoji: '👍', userId: ME, familyId: FAMILY })).legacy).toBe(false);
    expect((await createFamilyConversation(db, { family_id: FAMILY, name: 'X', kind: 'group', avatar_emoji: '💬', created_by: ME, member_ids: [ME], participant_ids: [ME_MEMBER] })).error).toBeNull();
    expect(calls.filter((c) => c.kind === 'rpc').map((c) => c.name)).toEqual([
      'ensure_family_conversation', 'family_conversation_overview', 'mark_conversation_read_through',
      'toggle_family_message_reaction', 'create_family_conversation',
    ]);
    expect(calls.some((c) => c.kind === 'insert' || c.kind === 'update' || c.name === 'family_messages')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('any other error is still the error it is', () => {
  const denied: Err = { code: '42501', message: 'permission denied for function' };
  const otherMissing = (name: string): Err => missingFunction(`${name}_v2`, {});
  const helperMissing: Err = { code: '42883', message: 'function messaging_private.can_access_conversation(uuid) does not exist' };

  it.each([denied, otherMissing('ensure_family_conversation'), helperMissing])('ensure: %j', async (error) => {
    const { db, calls } = memoryDb({ has0475: false, ...seed(false), rpcErrors: { ensure_family_conversation: error } });
    expect(await ensureFamilyChat(db, { familyId: FAMILY, userId: ME, name: 'Family Chat', members: MEMBERS })).toEqual({ error, legacy: false });
    expect(calls.filter((c) => c.kind !== 'rpc')).toEqual([]);
  });

  it.each([denied, otherMissing('create_family_conversation')])('create: %j', async (error) => {
    const { db, calls } = memoryDb({ has0475: false, conversations: [], messages: [], rpcErrors: { create_family_conversation: error } });
    const res = await createFamilyConversation(db, { family_id: FAMILY, name: 'X', kind: 'group', avatar_emoji: '💬', created_by: ME, member_ids: [ME], participant_ids: [ME_MEMBER] });
    expect(res.error).toEqual(error);
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it.each([denied, otherMissing('family_conversation_overview')])('summaries: %j', async (error) => {
    const { db, calls } = memoryDb({ has0475: false, ...seed(false), rpcErrors: { family_conversation_overview: error } });
    expect(await loadConversationSummaries(db, { familyId: FAMILY, userId: ME })).toEqual({ data: null, error });
    expect(calls.some((c) => c.name === 'family_messages')).toBe(false);
  });

  it.each([denied, otherMissing('mark_conversation_read_through')])('mark read: %j', async (error) => {
    const { db, calls, tables } = memoryDb({ has0475: false, ...seed(false), rpcErrors: { mark_conversation_read_through: error } });
    expect(await markConversationReadThrough(db, { conversationId: 'family-group', messageId: 'm-2', familyId: FAMILY, userId: ME, rows: tables.family_messages.map(asMessage) }))
      .toEqual({ error, legacy: false });
    expect(calls.map((c) => c.name)).toEqual(['mark_conversation_read_through']);
  });

  it.each([denied, otherMissing('toggle_family_message_reaction')])('reaction: %j', async (error) => {
    const { db, calls } = memoryDb({ has0475: false, ...seed(false), rpcErrors: { toggle_family_message_reaction: error } });
    expect(await toggleMessageReaction(db, { message: asMessage(message('m-1', 'family-group')), emoji: '👍', userId: ME, familyId: FAMILY }))
      .toEqual({ data: null, error, legacy: false });
    expect(calls.some((c) => c.kind === 'update')).toBe(false);
  });

  it('a failed inbox read is still an error, not an empty legacy inbox', async () => {
    const { db } = memoryDb({ has0475: false, ...seed(false) });
    const failing = { ...db, from: () => { throw new Error('fetch failed'); } } as unknown as SupabaseClient<Database>;
    const inbox = await loadInbox(failing, { familyId: FAMILY, userId: ME, selfMemberId: ME_MEMBER });
    expect(inbox.rows).toBeNull();
    expect(inbox.error).not.toBeNull();
  });
});

describe('MessagesModule takes these paths', () => {
  const source = readFileSync('components/modules/messages-module.tsx', 'utf8');
  it('loads, ensures, summarises, marks read and reacts through workspace-paths', () => {
    for (const call of ['await loadInbox(supabase,', 'await ensureFamilyChat(supabase,', 'await loadConversationSummaries(supabase,',
      'await markConversationReadThrough(supabase,', 'await toggleMessageReaction(createClient(),', 'return createFamilyConversation(createClient(), payload);']) {
      expect(source).toContain(call);
    }
  });

  it('no longer blanks the inbox or toasts when the old schema is detected', () => {
    expect(source).not.toContain('setConversations([])');
    const ensure = source.slice(source.indexOf('// ── Ensure Family Chat exists'), source.indexOf('// ── Load messages for active conv'));
    expect(ensure).toContain("if (error && legacy) console.error('[messages] family chat fallback failed'");
    expect(ensure).toMatch(/else if \(error\) toastError\(/);
  });

  it('joins the old public presence topic before 0475 and the private one after', () => {
    expect(source).toContain('config: legacy0475 ? { presence: { key: userId } } : { private: true, presence: { key: userId } }');
  });

  it('joins no realtime topic until the first Family Chat ensure has settled the schema', () => {
    const ensure = source.slice(source.indexOf('// ── Ensure Family Chat exists'), source.indexOf('// ── Load messages for active conv'));
    expect(ensure).toContain('setSchemaSettled(true);');
    expect(source).toContain('if (!activeConvId || !schemaSettled || legacy0475) return;');
    const presence = source.slice(source.indexOf('// ── Presence: who in the family is online'));
    expect(presence.slice(0, 200)).toContain('if (!schemaSettled) return;');
  });

  it('offers no archive action before 0475, as the previous build did not', () => {
    const gate = source.slice(source.indexOf('function canArchiveConversation()'));
    expect(gate.slice(0, 400)).toContain('!activeConv.is_family_chat && !legacy0475');
    expect(source).toContain('canManageConversation && !activeConv.is_family_chat && !legacy0475 && <button type="button" onClick={openArchiveAction}');
  });
});
