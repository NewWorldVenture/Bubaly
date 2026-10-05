// What main did before the messaging build-out, kept for databases that have
// not taken 0475/0476 (see lib/messages/schema-compat.ts for when each runs).
//
// Every function here is main's behaviour lifted out of the messages module as
// it stood before #834, not a new design. They are the fallbacks, so they must
// stay boring: when the migrations land, none of this runs.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { settle } from '@/lib/supabase/settle';
import { wroteNoRows } from '@/lib/supabase/errors';
import { summarizeConversations } from './overview';

type DB = SupabaseClient<Database>;
type Message = Tables<'family_messages'>;

export type LegacyConversationInsert = {
  family_id: string; name: string | null; kind: string;
  avatar_emoji: string | null; created_by: string;
  member_ids: string[]; participant_ids: string[];
};

/**
 * main's createConversation: a direct insert, retried without participant_ids
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
 * main's "ensure Family Chat exists": any group conversation counts; with none,
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

/**
 * main's reaction toggle: read-modify-write of the reactions map, scoped by
 * family and read back. `unsaved` is RLS's silent refusal (no error, no row).
 */
export async function legacyToggleReaction(
  db: DB,
  input: { message: Message; emoji: string; userId: string; familyId: string },
): Promise<{ data: Message | null; error: { message: string } | null; unsaved: boolean }> {
  const current = (input.message.reactions as Record<string, string[]> | null) ?? {};
  const existing = current[input.emoji] ?? [];
  const updated: Record<string, string[]> = existing.includes(input.userId)
    ? { ...current, [input.emoji]: existing.filter((u) => u !== input.userId) }
    : { ...current, [input.emoji]: [...existing, input.userId] };
  for (const k of Object.keys(updated)) { if (!updated[k].length) delete updated[k]; }
  const { data, error } = await settle(db.from('family_messages').update({ reactions: updated })
    .eq('id', input.message.id).eq('family_id', input.familyId).select('*'));
  if (error) return { data: null, error, unsaved: false };
  if (wroteNoRows(data)) return { data: null, error: null, unsaved: true };
  return { data: data?.[0] ?? null, error: null, unsaved: false };
}

/**
 * main's read receipts: 0163's mark_conversation_read appends the reader in one
 * statement; failing that, a per-row append over the rows on screen. Best
 * effort — a receipt that did not land is logged, not shown.
 */
export async function legacyMarkConversationRead(
  db: DB,
  input: { conversationId: string; familyId: string; userId: string; rows: readonly Message[] },
): Promise<void> {
  const { error: rpcErr } = await settle(db.rpc('mark_conversation_read', { p_conversation_id: input.conversationId }));
  if (!rpcErr) return;
  const unread = input.rows.filter((m) => !(m.read_by ?? []).includes(input.userId)).slice(-100);
  for (const m of unread) {
    const { data: marked, error } = await settle(db.from('family_messages')
      .update({ read_by: [...(m.read_by ?? []), input.userId] })
      .eq('id', m.id).eq('family_id', input.familyId).select('id'));
    if (error) { console.error('[messages] read-receipt fallback failed', { message: error.message }); break; }
    if (wroteNoRows(marked)) { console.warn('[messages] read receipt did not land', { id: m.id }); break; }
  }
}

/** main's previews and unread badges: one bounded scan of the family's recent messages. */
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

/** main's per-conversation mute: a device-local preference. */
export function readDeviceMutes(familyId: string): Set<string> {
  try {
    const raw = localStorage.getItem(muteKey(familyId));
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}

export function writeDeviceMutes(familyId: string, ids: ReadonlySet<string>): void {
  try { localStorage.setItem(muteKey(familyId), JSON.stringify([...ids])); } catch { /* storage unavailable */ }
}
