// Messaging on production's schema, which has not taken 0475/0476.
//
// Each path that needs a new object falls back to main's behaviour (or hides
// the feature) only when the database says that EXACT object is missing, and
// says so once in the console, naming the migration. Anything else — a
// different object, a different error — is the failure it is.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import {
  fellBackForMissing, isMissingSchemaObject, MESSAGING_MIGRATIONS, MESSAGING_SCHEMA,
  resetMissingMigrationWarnings, type SchemaObject,
} from '@/lib/messages/schema-compat';
import {
  legacyConversationSummaries, legacyEnsureFamilyChat, legacyMarkConversationRead, legacyToggleReaction,
} from '@/lib/messages/legacy-schema';

const S = MESSAGING_SCHEMA;

describe('a missing object is recognised only by its own name and code', () => {
  const cases: [SchemaObject, { code: string; message: string }][] = [
    [S.ensureFamilyConversation, { code: 'PGRST202', message: 'Could not find the function public.ensure_family_conversation(p_family_id) in the schema cache' }],
    [S.ensureFamilyConversation, { code: '42883', message: 'function public.ensure_family_conversation(uuid) does not exist' }],
    [S.markReadThrough, { code: 'PGRST202', message: 'Could not find the function public.mark_conversation_read_through(p_conversation_id, p_message_id) in the schema cache' }],
    [S.conversationPreferences, { code: 'PGRST205', message: "Could not find the table 'public.family_conversation_preferences' in the schema cache" }],
    [S.conversationPreferences, { code: '42P01', message: 'relation "public.family_conversation_preferences" does not exist' }],
    [S.messageIdempotencyKey, { code: 'PGRST204', message: "Could not find the 'idempotency_key' column of 'family_messages' in the schema cache" }],
    [S.messageIdempotencyKey, { code: '42703', message: 'column family_messages.idempotency_key does not exist' }],
    [S.isFamilyChat, { code: '42703', message: 'column "is_family_chat" of relation "family_conversations" does not exist' }],
  ];
  it.each(cases)('%o is missing for %o', (object, error) => {
    expect(isMissingSchemaObject(error, object)).toBe(true);
  });

  it('refuses another object, another schema, a longer name, or another kind of error', () => {
    // A different function, including one this name is a prefix of.
    expect(isMissingSchemaObject({ code: 'PGRST202', message: 'Could not find the function public.mark_conversation_read_through(p_conversation_id, p_message_id) in the schema cache' },
      { kind: 'function', name: 'mark_conversation_read', migration: '0475' })).toBe(false);
    // The RPC exists but a private helper it calls does not: not the RPC missing.
    expect(isMissingSchemaObject({ code: '42883', message: 'function messaging_private.ensure_family_conversation(uuid) does not exist' }, S.ensureFamilyConversation)).toBe(false);
    expect(isMissingSchemaObject({ code: '42883', message: 'operator does not exist: uuid = text' }, S.toggleReaction)).toBe(false);
    // A missing-table code for a function name, and the reverse.
    expect(isMissingSchemaObject({ code: 'PGRST205', message: "Could not find the table 'public.ensure_family_conversation' in the schema cache" }, S.ensureFamilyConversation)).toBe(false);
    expect(isMissingSchemaObject({ code: 'PGRST202', message: 'Could not find the function public.family_conversation_preferences() in the schema cache' }, S.conversationPreferences)).toBe(false);
    // The same column name on another table.
    expect(isMissingSchemaObject({ code: '42703', message: 'column grocery_items.idempotency_key does not exist' }, S.messageIdempotencyKey)).toBe(false);
    expect(isMissingSchemaObject({ code: 'PGRST204', message: "Could not find the 'idempotency_key' column of 'todos' in the schema cache" }, S.messageIdempotencyKey)).toBe(false);
    // Unnamed, permission and transport failures.
    expect(isMissingSchemaObject({ code: 'PGRST202', message: 'RPC missing' }, S.ensureFamilyConversation)).toBe(false);
    expect(isMissingSchemaObject({ code: '42501', message: 'permission denied for function ensure_family_conversation' }, S.ensureFamilyConversation)).toBe(false);
    expect(isMissingSchemaObject({ message: 'fetch failed' }, S.ensureFamilyConversation)).toBe(false);
    expect(isMissingSchemaObject(null, S.ensureFamilyConversation)).toBe(false);
  });

  it('maps every object to the migration that adds it', () => {
    for (const object of Object.values(MESSAGING_SCHEMA)) {
      const file = MESSAGING_MIGRATIONS[object.migration];
      const sql = readFileSync(`supabase/migrations/${file}`, 'utf8');
      const added = object.kind === 'function' ? `create or replace function public.${object.name}(`
        : object.kind === 'table' ? `create table if not exists public.${object.name} (`
          : `alter table public.${object.table} add column if not exists ${object.name} `;
      expect(sql, `${file} should add ${object.name}`).toContain(added);
    }
  });
});

describe('the fallback warns once, naming the migration', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { resetMissingMigrationWarnings(); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('one warning per missing object, however often the path runs', () => {
    const error = { code: 'PGRST205', message: "Could not find the table 'public.family_conversation_preferences' in the schema cache" };
    expect(fellBackForMissing(error, S.conversationPreferences, 'Mute is device-local.')).toBe(true);
    expect(fellBackForMissing(error, S.conversationPreferences, 'Mute is device-local.')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('0476_messaging_notifications_preferences.sql');
    expect(String(warn.mock.calls[0][0])).toContain('table public.family_conversation_preferences');
  });

  it('no warning and no fallback for any other error', () => {
    expect(fellBackForMissing({ code: '42501', message: 'permission denied' }, S.conversationPreferences, 'x')).toBe(false);
    expect(fellBackForMissing(null, S.conversationPreferences, 'x')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

// Every place the build-out reaches for a 0475/0476 object names its fallback.
describe('each messaging path that needs a new object has a fallback', () => {
  const SOURCES = ['components/modules/messages-module.tsx', 'lib/services/messages/index.ts'];
  for (const path of SOURCES) {
    it(`${path}`, () => {
      const source = readFileSync(path, 'utf8');
      for (const [key, object] of Object.entries(MESSAGING_SCHEMA)) {
        const used = object.kind === 'function' ? source.includes(`.rpc('${object.name}'`)
          : object.kind === 'table' ? source.includes(`.from('${object.name}')`)
            // A column counts where a query names it (select list, filter,
            // insert key), not where code reads it off a row it already has.
            : new RegExp(`(?:['"\`,]\\s*${object.name}\\b|\\b${object.name}\\s*:)`).test(source);
        if (used) expect(source, `${path} uses ${object.name} without MESSAGING_SCHEMA.${key}`).toContain(`MESSAGING_SCHEMA.${key}`);
      }
    });
  }
});

type Message = Tables<'family_messages'>;
type Call = { table: string; kind: string; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

function fakeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const c: Call = { table, kind: 'select', filters: {} }; calls.push(c);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (key: string, value: unknown) => { c.filters[key] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, eq: filter, is: filter,
      insert: (payload: unknown) => { c.kind = 'insert'; c.payload = payload; return b; },
      update: (payload: unknown) => { c.kind = 'update'; c.payload = payload; return b; },
      single: () => Promise.resolve(respond(c)),
      then: (resolve: (value: Reply) => unknown, reject?: (cause: unknown) => unknown) => Promise.resolve(respond(c)).then(resolve, reject),
    });
    return b;
  };
  const rpc = (name: string, args: Record<string, unknown>) => {
    const c: Call = { table: `rpc:${name}`, kind: 'rpc', filters: args }; calls.push(c);
    return Promise.resolve(respond(c));
  };
  return { db: { from, rpc } as unknown as SupabaseClient<Database>, calls };
}

const msg = (extra: Partial<Message> = {}) => ({
  id: 'm1', conversation_id: 'c1', family_id: 'f1', sender_id: 'u2', reactions: { '👍': ['u2'] }, read_by: ['u2'], ...extra,
}) as Message;

describe("main's behaviour, lifted out as the fallbacks", () => {
  it('reactions: toggles the reader in or out of the map, scoped by family, and reports a silent refusal', async () => {
    const { db, calls } = fakeDb((c) => ({ data: [{ ...msg(), reactions: c.payload && (c.payload as { reactions: unknown }).reactions }], error: null }));
    const added = await legacyToggleReaction(db, { message: msg(), emoji: '👍', userId: 'u1', familyId: 'f1' });
    expect(calls[0]).toMatchObject({ table: 'family_messages', kind: 'update', filters: { id: 'm1', family_id: 'f1' }, payload: { reactions: { '👍': ['u2', 'u1'] } } });
    expect(added).toMatchObject({ error: null, unsaved: false, data: { id: 'm1' } });
    await legacyToggleReaction(db, { message: msg({ reactions: { '👍': ['u1'] } }), emoji: '👍', userId: 'u1', familyId: 'f1' });
    expect(calls[1].payload).toEqual({ reactions: {} });

    const refused = fakeDb(() => ({ data: [], error: null }));
    expect(await legacyToggleReaction(refused.db, { message: msg(), emoji: '🔥', userId: 'u1', familyId: 'f1' })).toMatchObject({ data: null, unsaved: true });
  });

  it("read receipts: 0163's RPC first, then a per-row append that stops at the first failure", async () => {
    const ok = fakeDb(() => ({ data: null, error: null }));
    await legacyMarkConversationRead(ok.db, { conversationId: 'c1', familyId: 'f1', userId: 'u1', rows: [msg()] });
    expect(ok.calls.map((c) => c.table)).toEqual(['rpc:mark_conversation_read']);

    const noRpc = fakeDb((c) => c.kind === 'rpc' ? { data: null, error: { message: 'missing' } } : { data: [{ id: 'm1' }], error: null });
    await legacyMarkConversationRead(noRpc.db, { conversationId: 'c1', familyId: 'f1', userId: 'u1', rows: [msg(), msg({ id: 'm2', read_by: ['u1'] })] });
    expect(noRpc.calls.slice(1)).toEqual([expect.objectContaining({ kind: 'update', filters: { id: 'm1', family_id: 'f1' }, payload: { read_by: ['u2', 'u1'] } })]);
  });

  it('family chat: any group chat counts; none creates one with every member; a failed check creates nothing', async () => {
    const members = [{ id: 'mem1', user_id: 'u1' }, { id: 'mem2', user_id: null }];
    const exists = fakeDb(() => ({ data: [{ id: 'c1' }], error: null }));
    expect(await legacyEnsureFamilyChat(exists.db, { familyId: 'f1', userId: 'u1', name: 'Family Chat', members })).toEqual({ error: null });
    expect(exists.calls.some((c) => c.kind === 'insert')).toBe(false);

    const none = fakeDb((c) => c.kind === 'insert' ? { data: { id: 'new' }, error: null } : { data: [], error: null });
    expect(await legacyEnsureFamilyChat(none.db, { familyId: 'f1', userId: 'u1', name: 'Family Chat', members })).toEqual({ error: null });
    expect(none.calls.find((c) => c.kind === 'insert')?.payload).toMatchObject({ kind: 'group', member_ids: ['u1'], participant_ids: ['mem1', 'mem2'], created_by: 'u1' });

    const broken = fakeDb(() => ({ data: null, error: { message: 'timeout' } }));
    expect(await legacyEnsureFamilyChat(broken.db, { familyId: 'f1', userId: 'u1', name: 'Family Chat', members })).toEqual({ error: { message: 'timeout' } });
    expect(broken.calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it('previews and unread counts: one bounded scan, summarised for the reader', async () => {
    const rows = [
      { conversation_id: 'c1', content: 'hi', kind: 'text', attachment_name: null, sender_name: 'Bo', sender_id: 'u2', created_at: '2026-10-01T10:00:00Z', read_by: [] },
      { conversation_id: 'c1', content: 'yo', kind: 'text', attachment_name: null, sender_name: 'Bo', sender_id: 'u2', created_at: '2026-10-01T09:00:00Z', read_by: ['u1'] },
    ];
    const { db, calls } = fakeDb(() => ({ data: rows, error: null }));
    const result = await legacyConversationSummaries(db, { familyId: 'f1', userId: 'u1' });
    expect(calls[0].filters).toEqual({ family_id: 'f1', deleted_at: null });
    expect(result.data?.unreadByConv.get('c1')).toBe(1);
    expect(result.data?.lastByConv.get('c1')?.content).toBe('hi');
  });
});
