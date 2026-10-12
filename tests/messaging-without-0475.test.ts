// The messages workspace on production's schema, which has not taken 0475.
//
// Original participant access and an empty canonical Family Chat are required.
// Missing atomic/privacy schema reports unavailable instead of adopting history.
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
  markConversationReadThrough, presenceChannelConfig, presenceSchemaOf, receiptLanded, toggleMessageReaction,
} from '@/lib/messages/workspace-paths';
import { legacyMarkConversationRead } from '@/lib/messages/legacy-schema';
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
function memoryDb(options: {
  has0475: boolean; conversations: Row[]; messages: Row[]; rpcErrors?: Record<string, Err>; insertErrors?: Err[]; selectErrors?: Record<string, Err>;
  /** Per update call, in order: an error (a trigger or RLS refusal), 'no-rows' (RLS filtered it out), or undefined to apply it. */
  updateOutcomes?: Array<Err | 'no-rows' | undefined>;
  /** RPCs that succeed without touching a row, as a security-invoker update filtered by RLS does. */
  rpcNoops?: string[];
}) {
  const tables: Record<string, Row[]> = { family_conversations: options.conversations, family_messages: options.messages };
  const calls: Call[] = [];
  const insertErrors = [...(options.insertErrors ?? [])];
  const updateOutcomes = [...(options.updateOutcomes ?? [])];
  let nextId = 1;

  function from(table: string) {
    let action: 'select' | 'insert' | 'update' = 'select';
    let payload: Row | null = null;
    let columns = '*';
    const filters: [string, unknown][] = [];
    const inFilters: [string, unknown[]][] = [];
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
      let selected = rows.filter((row) => filters.every(([key, value]) => (row[key] ?? null) === value)
        && inFilters.every(([key, values]) => values.includes(row[key])));
      if (action === 'update') {
        const outcome = updateOutcomes.shift();
        if (outcome === 'no-rows') return { data: [], count: null, error: null };
        if (outcome) return { data: null, count: null, error: outcome };
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
      in: (key: string, values: unknown[]) => { inFilters.push([key, values]); return q; },
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
    if (options.rpcNoops?.includes(name)) return { data: null, error: null };
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

// Preserve the original five low-level receipt mutation/refusal assertions.
// This historical helper is no longer a missing-schema workspace fallback.
async function retainedLegacyReceiptProof(db: SupabaseClient<Database>, input: Parameters<typeof legacyMarkConversationRead>[1] & { messageId: string }) {
  return { ...(await legacyMarkConversationRead(db, input)), legacy: true };
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

describe('without 0475 the workspace preserves audiences and reports unavailable', () => {
  it("missing marker refuses the inbox without exposing other conversations", async () => {
    const { db, tables } = memoryDb({ has0475: false, ...seed(false) });
    const history = JSON.stringify(tables);
    const inbox = await loadInbox(db, { familyId: FAMILY, userId: ME, selfMemberId: ME_MEMBER });
    expect(inbox.error).toMatchObject({ code: 'messaging_schema_unavailable' });
    expect(inbox.rows).toBeNull();
    expect(JSON.stringify(tables)).toBe(history);
    expect(presenceChannelConfig(presenceSchemaOf(inbox), ME)).toBeNull();
  });

  it("missing canonical RPC neither adopts an old group nor creates an unmarked chat", async () => {
    for (const conversations of [seed(false).conversations, []]) {
      const { db, calls, tables } = memoryDb({ has0475: false, conversations, messages: [] });
      const history = JSON.stringify(tables);
      const result = await ensureFamilyChat(db, { familyId: FAMILY, userId: ME, name: 'Family Chat', members: MEMBERS });
      expect(result.error).toMatchObject({ code: 'messaging_schema_unavailable' });
      expect(calls.map((c) => c.name)).toEqual(['ensure_family_conversation']);
      expect(JSON.stringify(tables)).toBe(history);
    }
  });

  it("missing overview refuses without a family-wide message scan", async () => {
    const { db, calls } = memoryDb({ has0475: false, ...seed(false) });
    const result = await loadConversationSummaries(db, { familyId: FAMILY, userId: ME });
    expect(result).toMatchObject({ data: null, error: { code: 'messaging_schema_unavailable' } });
    expect(calls.map((c) => c.name)).toEqual(['family_conversation_overview']);
  });

  it("missing atomic read-through refuses instead of using the legacy receipt RPC", async () => {
    const { db, calls, tables } = memoryDb({ has0475: false, ...seed(false) });
    const history = JSON.stringify(tables);
    const rows = tables.family_messages.filter((m) => m.conversation_id === 'family-group').map(asMessage);
    expect((await markConversationReadThrough(db, { conversationId: 'family-group', messageId: 'm-2', familyId: FAMILY, userId: ME, rows })).error).toMatchObject({ code: 'messaging_schema_unavailable' });
    expect(calls.map((c) => c.name)).toEqual(['mark_conversation_read_through']);
    expect(JSON.stringify(tables)).toBe(history);
  });

  it("missing atomic read-through never attempts raw receipt updates", async () => {
    const { db, calls, tables } = memoryDb({ has0475: false, ...seed(false), rpcErrors: { mark_conversation_read: { code: '42501', message: 'permission denied' } } });
    tables.family_messages[0].read_by = [OTHER];
    const history = JSON.stringify(tables);
    const rows = tables.family_messages.filter((m) => m.conversation_id === 'family-group').map(asMessage);
    expect((await markConversationReadThrough(db, { conversationId: 'family-group', messageId: 'm-2', familyId: FAMILY, userId: ME, rows })).error).toMatchObject({ code: 'messaging_schema_unavailable' });
    expect(calls.filter((c) => c.kind === 'update')).toEqual([]);
    expect(JSON.stringify(tables)).toBe(history);
  });

  it("missing atomic reaction refuses instead of raw-updating the reactions map", async () => {
    const { db, calls, tables } = memoryDb({ has0475: false, ...seed(false) });
    const history = JSON.stringify(tables);
    expect(await toggleMessageReaction(db, { message: asMessage(message('m-1', 'family-group')), emoji: '👍', userId: ME, familyId: FAMILY })).toMatchObject({ data: null, error: { code: 'messaging_schema_unavailable' } });
    expect(calls.filter((c) => c.kind === 'update')).toEqual([]);
    expect(JSON.stringify(tables)).toBe(history);
  });

  it("missing atomic create never retries a direct insert without participant identities", async () => {
    const payload = { family_id: FAMILY, name: 'Blair', kind: 'direct', avatar_emoji: null, created_by: ME, member_ids: [ME, OTHER], participant_ids: [ME_MEMBER, 'member-other'] };
    for (const insertErrors of [[], [{ code: 'PGRST204', message: "Could not find the 'participant_ids' column of 'family_conversations' in the schema cache" }]]) {
      const { db, calls } = memoryDb({ has0475: false, conversations: [], messages: [], insertErrors });
      expect((await createFamilyConversation(db, payload)).error).toMatchObject({ code: 'messaging_schema_unavailable' });
      expect(calls.filter((c) => c.kind === 'insert')).toEqual([]);
    }
  });

  it("missing atomic create refuses without adopting even a matching legacy DM", async () => {
    const payload = { family_id: FAMILY, name: 'Blair', kind: 'direct', avatar_emoji: null, created_by: ME, member_ids: [ME, OTHER], participant_ids: ['member-other', ME_MEMBER] };
    for (const conversations of [seed(false).conversations, []]) {
      const { db, calls, tables } = memoryDb({ has0475: false, conversations, messages: [] });
      const history = JSON.stringify(tables);
      expect((await createFamilyConversation(db, payload)).error).toMatchObject({ code: 'messaging_schema_unavailable' });
      expect(calls.map((c) => c.name)).toEqual(['create_family_conversation']);
      expect(JSON.stringify(tables)).toBe(history);
    }
  });

  it("missing atomic create leaves old account-holder DMs unchanged for both same and different rosters", async () => {
    const { db, calls, tables } = memoryDb({ has0475: false, conversations: [conversation('old-dm', { kind: 'direct', member_ids: [OTHER, ME], participant_ids: [] }, false)], messages: [] });
    const history = JSON.stringify(tables);
    const base = { family_id: FAMILY, name: 'Blair', kind: 'direct', avatar_emoji: null, created_by: ME };
    for (const audience of [{ member_ids: [ME, OTHER], participant_ids: [ME_MEMBER, 'member-other'] }, { member_ids: [ME], participant_ids: [ME_MEMBER, 'member-kid'] }]) expect((await createFamilyConversation(db, { ...base, ...audience })).error).toMatchObject({ code: 'messaging_schema_unavailable' });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
    expect(JSON.stringify(tables)).toBe(history);
  });

  it("a missing atomic DM create does not attempt a family-wide lookup even if it would fail", async () => {
    const denied: Err = { code: '42501', message: 'permission denied for table family_conversations' };
    const { db, calls } = memoryDb({ has0475: false, ...seed(false), selectErrors: { family_conversations: denied } });
    const res = await createFamilyConversation(db, { family_id: FAMILY, name: 'Blair', kind: 'direct', avatar_emoji: null, created_by: ME, member_ids: [ME, OTHER], participant_ids: [ME_MEMBER, 'member-other'] });
    expect(res).toMatchObject({ data: null, error: { code: 'messaging_schema_unavailable' } });
    expect(calls.map((c) => c.name)).toEqual(['create_family_conversation']);
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

describe('a read receipt that did not land is not shown as read', () => {
  const rpcRefused = { mark_conversation_read: { code: '42501', message: 'permission denied' } };
  // What the module holds: its own copies, not the database's rows.
  const onScreen = (rows: Row[]) => rows.map((row) => asMessage(structuredClone(row)));
  const through = (rows: Row[], readIds: string[] | null | undefined) =>
    rows.filter((row) => receiptLanded(asMessage(row), asMessage(rows.at(-1)!), readIds)).map((row) => row.id);

  it('a refused per-row append is an error and leaves the rows unread', async () => {
    const refusal: Err = { code: '42501', message: "A read receipt is only its reader's to add or remove" };
    const { db, tables } = memoryDb({ has0475: false, ...seed(false), rpcErrors: rpcRefused, updateOutcomes: [refusal] });
    const rows = tables.family_messages.filter((m) => m.conversation_id === 'family-group');
    const res = await retainedLegacyReceiptProof(db, { conversationId: 'family-group', messageId: 'm-2', familyId: FAMILY, userId: ME, rows: onScreen(rows) });
    expect(res).toEqual({ error: refusal, legacy: true, readIds: [] });
    expect(through(rows, res.readIds)).toEqual([]);
    expect(rows.every((m) => !(m.read_by as string[]).includes(ME))).toBe(true);
  });

  it('a per-row append that writes no row is an error, and only the receipts before it are shown', async () => {
    const { db, tables } = memoryDb({ has0475: false, ...seed(false), rpcErrors: rpcRefused, updateOutcomes: [undefined, 'no-rows'] });
    const rows = tables.family_messages.filter((m) => m.conversation_id === 'family-group');
    const res = await retainedLegacyReceiptProof(db, { conversationId: 'family-group', messageId: 'm-2', familyId: FAMILY, userId: ME, rows: onScreen(rows) });
    expect(res.error).not.toBeNull();
    expect(res.readIds).toEqual(['m-1']);
    expect(through(rows, res.readIds)).toEqual(['m-1']);
  });

  it("0163's RPC succeeding without touching a row is an error, read back rather than assumed", async () => {
    const { db, calls, tables } = memoryDb({ has0475: false, ...seed(false), rpcNoops: ['mark_conversation_read'] });
    const rows = tables.family_messages.filter((m) => m.conversation_id === 'family-group');
    const res = await retainedLegacyReceiptProof(db, { conversationId: 'family-group', messageId: 'm-2', familyId: FAMILY, userId: ME, rows: onScreen(rows) });
    expect(res.error).not.toBeNull();
    expect(res.readIds).toEqual([]);
    expect(through(rows, res.readIds)).toEqual([]);
    expect(calls.filter((c) => c.kind === 'update')).toEqual([]);
  });

  it("a failed read-back after 0163's RPC is an error, with nothing shown as read", async () => {
    const readFailed: Err = { message: 'fetch failed' };
    const { db, tables } = memoryDb({ has0475: false, ...seed(false), selectErrors: { family_messages: readFailed } });
    const rows = tables.family_messages.filter((m) => m.conversation_id === 'family-group');
    const res = await retainedLegacyReceiptProof(db, { conversationId: 'family-group', messageId: 'm-2', familyId: FAMILY, userId: ME, rows: onScreen(rows) });
    expect(res).toEqual({ error: readFailed, legacy: true, readIds: [] });
  });

  it('a successful receipt still shows every row through the newest as read', async () => {
    const { db, tables } = memoryDb({ has0475: false, ...seed(false) });
    const rows = tables.family_messages.filter((m) => m.conversation_id === 'family-group');
    const res = await retainedLegacyReceiptProof(db, { conversationId: 'family-group', messageId: 'm-2', familyId: FAMILY, userId: ME, rows: onScreen(rows) });
    expect(res.error).toBeNull();
    expect(through(rows, res.readIds)).toEqual(['m-1', 'm-2']);
    expect(rows.every((m) => (m.read_by as string[]).includes(ME))).toBe(true);
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

  it('shows as read only the receipts that landed, and keeps the rest unread on a failure', () => {
    const mark = source.slice(source.indexOf('await markConversationReadThrough(supabase,'), source.indexOf('// ── Presence: who in the family is online'));
    expect(mark).toContain('if (error && !readIds?.length) return;');
    expect(mark).toContain('if (!receiptLanded(row, newest, readIds)) return row;');
  });

  it("clears unauthorized history and shows a failure when privacy schema is unavailable", () => {
    const load = source.slice(source.indexOf('// ── Load conversations'), source.indexOf('// ── Ensure Family Chat exists'));
    expect(load).toContain("if (error?.code === 'messaging_schema_unavailable')");
    for (const command of ["setPresenceSchema('unknown')", 'owner.current.select(null)', 'setConversations([])', 'setMessages([])', 'setActiveConv(null)']) expect(load).toContain(command);
    const ensure = source.slice(source.indexOf('// ── Ensure Family Chat exists'), source.indexOf('// ── Load messages for active conv'));
    expect(ensure).not.toContain('family chat fallback failed');
    expect(ensure).toContain('if (error) toastError(');
  });

  it("joins presence only through verified inbox configuration and clears it on privacy schema failure", () => {
    const presence = source.slice(source.indexOf('// ── Presence: who in the family is online'), source.indexOf('function acceptMessage'));
    expect(presence).toContain('const config = presenceChannelConfig(presenceSchema, userId);');
    expect(presence).toContain('if (!config) return;');
    expect(presence).toContain('supabase.channel(`presence:family:${familyId}`, { config });');
    expect(presence).toContain('}, [familyId, userId, schemaSettled, presenceSchema]);');
    expect(presence).not.toContain('legacy0475');
    const load = source.slice(source.indexOf('// ── Load conversations'), source.indexOf('// ── Ensure Family Chat exists'));
    expect(load).toContain('setPresenceSchema(presenceSchemaOf({ legacy }));');
    expect(load).toContain("setPresenceSchema('unknown')");
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

describe('presence follows only the evidence that 0475 is wholly absent', () => {
  const PRIVATE = { private: true, presence: { key: ME } };

  it("fully absent privacy marker authorizes no presence topic", async () => {
    const { db } = memoryDb({ has0475: false, ...seed(false) });
    const inbox = await loadInbox(db, { familyId: FAMILY, userId: ME, selfMemberId: ME_MEMBER });
    expect(inbox.error).toMatchObject({ code: 'messaging_schema_unavailable' });
    expect(presenceChannelConfig(presenceSchemaOf(inbox), ME)).toBeNull();
  });

  it('fully present: the private topic, unchanged', async () => {
    const { db, tables } = memoryDb({ has0475: true, ...seed(true) });
    const inbox = await loadInbox(db, { familyId: FAMILY, userId: ME, selfMemberId: ME_MEMBER });
    const rows = tables.family_messages.map(asMessage);
    expect((await toggleMessageReaction(db, { message: rows[0], emoji: '👍', userId: ME, familyId: FAMILY })).legacy).toBe(false);
    expect(presenceChannelConfig(presenceSchemaOf(inbox), ME)).toEqual(PRIVATE);
  });

  it("partial schema refuses missing atomic mutations while verified presence stays private", async () => {
    const rpcErrors = { toggle_family_message_reaction: missingFunction('toggle_family_message_reaction', { p_emoji: '', p_message_id: '' }), mark_conversation_read_through: missingFunction('mark_conversation_read_through', { p_conversation_id: '', p_message_id: '' }) };
    const { db, tables } = memoryDb({ has0475: true, ...seed(true), rpcErrors });
    const history = JSON.stringify(tables);
    const inbox = await loadInbox(db, { familyId: FAMILY, userId: ME, selfMemberId: ME_MEMBER });
    const rows = tables.family_messages.map(asMessage);
    expect((await toggleMessageReaction(db, { message: rows[0], emoji: '👍', userId: ME, familyId: FAMILY })).error).toMatchObject({ code: 'messaging_schema_unavailable' });
    expect((await markConversationReadThrough(db, { conversationId: 'family-group', messageId: 'm-2', familyId: FAMILY, userId: ME, rows })).error).toMatchObject({ code: 'messaging_schema_unavailable' });
    expect(presenceChannelConfig(presenceSchemaOf(inbox), ME)).toEqual(PRIVATE);
    expect(JSON.stringify(tables)).toBe(history);
  });

  it('joins nothing until an inbox read has answered', () => {
    expect(presenceChannelConfig(presenceSchemaOf(null), ME)).toBeNull();
  });
});
