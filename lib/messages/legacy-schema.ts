// What the previous production build (82f2db1) did before the messaging
// build-out, kept for databases that have not taken 0475/0476 (see
// lib/messages/schema-compat.ts for when each runs).
//
// Every function here is that build's behaviour lifted out of the messages
// module, not a new design. They are the fallbacks, so they must stay boring:
// once the migrations land, none of this runs.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { settle } from '@/lib/supabase/settle';
import { wroteNoRows } from '@/lib/supabase/errors';
import { summarizeConversations } from './overview';

type DB = SupabaseClient<Database>;
type Message = Tables<'family_messages'>;
type Conversation = Tables<'family_conversations'>;

export type LegacyConversationInsert = {
  family_id: string; name: string | null; kind: string;
  avatar_emoji: string | null; created_by: string;
  member_ids: string[]; participant_ids: string[];
};

/**
 * The old createConversation: a direct insert, retried without participant_ids
 * on a database that predates 0017.
 */
export async function legacyCreateConversation(db: DB, payload: LegacyConversationInsert) {
  let res = await db.from('family_conversations').insert(payload).select('*').single();
  if (res.error && /participant_ids|schema cache|column/i.test(res.error.message)) {
    const { participant_ids: _omitted, ...legacy } = payload;
    res = await db.from('family_conversations').insert(legacy).select('*').single();
  }
  return res;
}

/**
 * The old 1:1 reuse: starting a DM with someone you already have one with
 * opened that conversation instead of inserting a duplicate. The roster
 * matches on participant_ids, or on member_ids for a row recorded before
 * participant ids, exactly as the old dialog compared its inbox rows. A failed
 * read is returned as the error, so it never produces a duplicate either.
 */
export async function legacyExistingDirect(db: DB, payload: LegacyConversationInsert) {
  const { data, error } = await settle(db.from('family_conversations').select('*')
    .eq('family_id', payload.family_id).eq('kind', 'direct')
    .order('last_message_at', { ascending: false, nullsFirst: false }));
  if (error) return { data: null, error };
  const targetP = [...payload.participant_ids].sort().join(',');
  const targetU = [...payload.member_ids].sort().join(',');
  const existing = (data ?? []).find((c) => {
    if (c.participant_ids?.length) return [...c.participant_ids].sort().join(',') === targetP;
    return [...(c.member_ids ?? [])].sort().join(',') === targetU;
  });
  return { data: existing ?? null, error: null };
}

/**
 * The old "ensure Family Chat exists": any group conversation counts; with none,
 * one is created holding every member. A failed existence check creates
 * nothing, so a read error never produces a duplicate chat.
 */
export async function legacyEnsureFamilyChat(
  db: DB,
  input: { familyId: string; userId: string; name: string; members: ReadonlyArray<{ id: string; user_id: string | null }> },
): Promise<{ error: { message: string } | null }> {
  const { data, error } = await settle(db.from('family_conversations').select('id')
    .eq('family_id', input.familyId).eq('kind', 'group').limit(1));
  if (error) return { error };
  if (data?.length) return { error: null };
  const created = await legacyCreateConversation(db, {
    family_id: input.familyId,
    name: input.name,
    kind: 'group',
    avatar_emoji: '👨‍👩‍👧‍👦',
    created_by: input.userId,
    member_ids: input.members.map((m) => m.user_id).filter((id): id is string => Boolean(id)),
    participant_ids: input.members.map((m) => m.id),
  });
  return { error: created.error };
}

/** The old auto-selected Family Chat: the first group that is not a DM. */
export function legacyFamilyChat(rows: readonly Conversation[]): Conversation | undefined {
  return rows.find((c) => c.kind === 'group' && !c.name?.includes('DM'));
}

/**
 * The old reaction toggle: read-modify-write of the reactions map, scoped by
 * family and read back. A refused row (RLS: no error, no row) returns no data.
 */
export async function legacyToggleReaction(
  db: DB,
  input: { message: Message; emoji: string; userId: string; familyId: string },
): Promise<{ data: Message | null; error: { message: string } | null }> {
  const current = (input.message.reactions as Record<string, string[]> | null) ?? {};
  const existing = current[input.emoji] ?? [];
  const updated: Record<string, string[]> = existing.includes(input.userId)
    ? { ...current, [input.emoji]: existing.filter((u) => u !== input.userId) }
    : { ...current, [input.emoji]: [...existing, input.userId] };
  for (const k of Object.keys(updated)) { if (!updated[k].length) delete updated[k]; }
  const { data, error } = await settle(db.from('family_messages').update({ reactions: updated })
    .eq('id', input.message.id).eq('family_id', input.familyId).select('*'));
  if (error) return { data: null, error };
  if (wroteNoRows(data)) return { data: null, error: null };
  return { data: data?.[0] ?? null, error: null };
}

/**
 * The old read receipts: 0163's mark_conversation_read appends the reader in
 * one statement; failing that, a per-row append over the rows on screen.
 *
 * Which rows really became read is reported, so the caller never shows a
 * receipt that did not land. 0163's RPC returns void and is security invoker,
 * so a success that touched no row (RLS, a conversation the caller cannot
 * write) looks like any other: the rows it should have marked are read back,
 * and any not carrying the reader is a failure. A per-row append that errors
 * (0463 refuses one built from a stale read_by) or writes no row stops the
 * fallback and is a failure; the rows appended before it still count.
 *
 * `readIds` null means every row passed in that is unread for the reader is
 * now read; otherwise exactly those ids are.
 */
export async function legacyMarkConversationRead(
  db: DB,
  input: { conversationId: string; familyId: string; userId: string; rows: readonly Message[] },
): Promise<{ error: { message: string } | null; readIds: string[] | null }> {
  const { error: rpcErr } = await settle(db.rpc('mark_conversation_read', { p_conversation_id: input.conversationId }));
  if (!rpcErr) return confirmConversationRead(db, input);
  const readIds: string[] = [];
  const unread = input.rows.filter((m) => !(m.read_by ?? []).includes(input.userId)).slice(-100);
  for (const m of unread) {
    const { data: marked, error } = await settle(db.from('family_messages')
      .update({ read_by: [...(m.read_by ?? []), input.userId] })
      .eq('id', m.id).eq('family_id', input.familyId).select('id'));
    if (error) {
      console.error('[messages] read-receipt fallback failed', { message: error.message });
      return { error, readIds };
    }
    if (wroteNoRows(marked)) {
      console.warn('[messages] read receipt did not land', { id: m.id });
      return { error: { message: 'The read receipt was not saved.' }, readIds };
    }
    readIds.push(m.id);
  }
  return { error: null, readIds };
}

/** After 0163's RPC: read back the rows it should have marked; any still unread for the reader is a failure. */
async function confirmConversationRead(
  db: DB,
  input: { conversationId: string; familyId: string; userId: string; rows: readonly Message[] },
): Promise<{ error: { message: string } | null; readIds: string[] | null }> {
  const expected = input.rows
    .filter((m) => !m.deleted_at && m.conversation_id === input.conversationId && !(m.read_by ?? []).includes(input.userId))
    .map((m) => m.id);
  if (!expected.length) return { error: null, readIds: null };
  const { data, error } = await settle(db.from('family_messages').select('id, read_by, deleted_at')
    .eq('family_id', input.familyId).eq('conversation_id', input.conversationId).in('id', expected));
  if (error) return { error, readIds: [] };
  const seen = new Map((data ?? []).map((row) => [row.id, row]));
  const readIds: string[] = [];
  let missed = false;
  for (const id of expected) {
    const row = seen.get(id);
    if (row?.deleted_at) continue; // deleted since: 0163 skips it, and it is no longer shown
    if (row && (row.read_by ?? []).includes(input.userId)) readIds.push(id);
    else missed = true;
  }
  if (!missed) return { error: null, readIds: null };
  console.warn('[messages] read receipts did not land', { conversationId: input.conversationId });
  return { error: { message: 'The read receipt was not saved.' }, readIds };
}

/** The old previews and unread badges: one bounded scan of the family's recent messages. */
export async function legacyConversationSummaries(db: DB, input: { familyId: string; userId: string }) {
  const { data, error } = await settle(db.from('family_messages')
    .select('conversation_id, content, kind, attachment_name, sender_name, sender_id, created_at, read_by')
    .eq('family_id', input.familyId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(400));
  if (error) return { data: null, error };
  return { data: summarizeConversations(data ?? [], input.userId), error: null };
}

const muteKey = (familyId: string) => `muted-convs:${familyId}`;

/** The old per-conversation mute: a device-local preference. */
export function readDeviceMutes(familyId: string): Set<string> {
  try {
    const raw = localStorage.getItem(muteKey(familyId));
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}

export function writeDeviceMutes(familyId: string, ids: ReadonlySet<string>): void {
  try { localStorage.setItem(muteKey(familyId), JSON.stringify([...ids])); } catch { /* storage unavailable */ }
}
