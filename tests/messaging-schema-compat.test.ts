// Messaging on production's schema, which has not taken 0475/0476.
//
// Harmless preferences may fall back only when their EXACT object is missing;
// privacy-sensitive reads and writes refuse missing schema. The helper
// says so once in the console, naming the migration. Anything else — a
// different object, a different error — is the failure it is.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fellBackForMissing, isMissingSchemaObject, MESSAGING_MIGRATIONS, MESSAGING_SCHEMA,
  resetMissingMigrationWarnings, type SchemaObject,
} from '@/lib/messages/schema-compat';

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
