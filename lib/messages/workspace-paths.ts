// The messages workspace's database paths, each taking the 0475 object first
// and the previous production behaviour (legacy-schema.ts) only when that exact
// object is missing (schema-compat.ts). With 0475 applied every function here
// is the call the module made before, unchanged; any other error is returned
// for the module to surface as it always has.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { settle } from '@/lib/supabase/settle';
import type { summarizeConversations } from './overview';
import { readConversationInbox, readConversationOverview } from './reads';
import { fellBackForMissing, MESSAGING_SCHEMA, warnMissingMigration } from './schema-compat';
import {
  legacyConversationSummaries, legacyCreateConversation, legacyEnsureFamilyChat, legacyExistingDirect, legacyFamilyChat,
  legacyMarkConversationRead, legacyToggleReaction, type LegacyConversationInsert,
} from './legacy-schema';

type DB = SupabaseClient<Database>;
type Conversation = Tables<'family_conversations'>;
type Message = Tables<'family_messages'>;
type DbError = { message: string; code?: string; details?: string; hint?: string };
export type ConversationSummaries = ReturnType<typeof summarizeConversations>;

/**
 * Which inbox rows this viewer sees. Before 0475 no row carries
 * is_family_chat and that schema's RLS is family-wide: every row the read
 * returns is listed, as before the build-out.
 */
export function inboxRows(data: readonly Conversation[] | null, viewer: { userId: string; selfMemberId: string | null | undefined }) {
  const legacy = Boolean(data?.some((row) => !(MESSAGING_SCHEMA.isFamilyChat.name in row)));
  if (legacy) {
    warnMissingMigration(MESSAGING_SCHEMA.isFamilyChat, 'Every conversation the family can read is listed, as before the build-out.');
    return { rows: [...(data ?? [])], legacy };
  }
  const rows = (data ?? []).filter((row) => row.is_family_chat
    || row.participant_ids?.includes(viewer.selfMemberId ?? '') || row.member_ids?.includes(viewer.userId)
    || (!row.participant_ids?.length && !row.member_ids?.length && row.created_by === viewer.userId));
  return { rows, legacy };
}

export async function loadInbox(db: DB, input: { familyId: string; userId: string; selfMemberId: string | null | undefined }) {
  const { data, error } = await readConversationInbox(db, input.familyId);
  if (error) return { rows: null, legacy: false, error };
  return { ...inboxRows(data, input), error: null };
}

/**
 * What the family presence topic may be, from the inbox read alone. Only the
 * conversations read answering without is_family_chat is evidence that 0475 is
 * entirely absent, and only then is the previous production build's public
 * topic joined. A missing or stale 0475 RPC (reactions, read receipts, the
 * Family Chat ensure) is not: with the column present presence stays on the
 * private topic, which simply fails to authorize if 0475's policies are
 * missing too. Until a read has answered, nothing is joined.
 */
export type PresenceSchema = 'unknown' | 'legacy' | 'current';
export function presenceSchemaOf(inbox: { legacy: boolean } | null): PresenceSchema {
  if (!inbox) return 'unknown';
  return inbox.legacy ? 'legacy' : 'current';
}
export function presenceChannelConfig(schema: PresenceSchema, userId: string) {
  if (schema === 'unknown') return null;
  return schema === 'legacy' ? { presence: { key: userId } } : { private: true, presence: { key: userId } };
}

/** The chat opened first: the canonical one, or before 0475 the first group that is not a DM. */
export function familyChatOf(rows: readonly Conversation[], legacy: boolean) {
  return legacy ? legacyFamilyChat(rows) : rows.find((conv) => conv.is_family_chat && !conv.is_archived);
}

export async function ensureFamilyChat(
  db: DB,
  input: { familyId: string; userId: string; name: string; members: ReadonlyArray<{ id: string; user_id: string | null }> },
): Promise<{ error: DbError | null; legacy: boolean }> {
  const { error } = await settle(db.rpc('ensure_family_conversation', { p_family_id: input.familyId }));
  if (!fellBackForMissing(error, MESSAGING_SCHEMA.ensureFamilyConversation,
    'Using the first group chat as the family chat, creating one with every member if there is none, as before the build-out.')) {
    return { error, legacy: false };
  }
  return { ...(await legacyEnsureFamilyChat(db, input)), legacy: true };
}

/**
 * Validate membership and deduplicate direct chats in one database transaction.
 * Before 0475 there is no such RPC: reuse the 1:1 chat with the same roster or
 * insert directly, as before the build-out.
 */
export async function createFamilyConversation(db: DB, payload: LegacyConversationInsert) {
  const res = await db.rpc('create_family_conversation', {
    p_family_id: payload.family_id, p_participant_ids: payload.participant_ids,
    p_name: payload.name, p_kind: payload.kind, p_avatar_emoji: payload.avatar_emoji ?? undefined,
  });
  if (!fellBackForMissing(res.error, MESSAGING_SCHEMA.createFamilyConversation,
    'Creating the conversation with a direct insert (reusing an existing 1:1 chat), as before the build-out.')) return res;
  if (payload.kind === 'direct') {
    const existing = await legacyExistingDirect(db, payload);
    if (existing.error || existing.data) return existing;
  }
  return legacyCreateConversation(db, payload);
}

/** Exact previews and unread counts; before 0475 a scan of the 400 most recent messages. */
export async function loadConversationSummaries(
  db: DB,
  input: { familyId: string; userId: string },
): Promise<{ data: ConversationSummaries | null; error: DbError | null }> {
  const { data, error } = await readConversationOverview(db, input.familyId);
  if (fellBackForMissing(error, MESSAGING_SCHEMA.conversationOverview,
    'Previews and unread counts come from a scan of the 400 most recent messages, as before the build-out.')) {
    return legacyConversationSummaries(db, input);
  }
  if (error) return { data: null, error };
  const next: ConversationSummaries = { lastByConv: new Map(), unreadByConv: new Map() };
  for (const row of data ?? []) {
    if (row.last_message) next.lastByConv.set(row.conversation_id, row.last_message as unknown as Message);
    next.unreadByConv.set(row.conversation_id, Number(row.unread_count));
  }
  return { data: next, error: null };
}

/** Read through `messageId`; before 0475, 0163's mark_conversation_read or a per-row append. */
export async function markConversationReadThrough(
  db: DB,
  input: { conversationId: string; messageId: string; familyId: string; userId: string; rows: readonly Message[] },
): Promise<{ error: DbError | null; legacy: boolean }> {
  const { error } = await settle(db.rpc('mark_conversation_read_through', { p_conversation_id: input.conversationId, p_message_id: input.messageId }));
  if (!fellBackForMissing(error, MESSAGING_SCHEMA.markReadThrough,
    "Read receipts use 0163's mark_conversation_read (or a per-row append), as before the build-out.")) {
    return { error, legacy: false };
  }
  await legacyMarkConversationRead(db, input);
  return { error: null, legacy: true };
}

/** Toggle the caller's reaction; before 0475 a read-modify-write of the message. */
export async function toggleMessageReaction(
  db: DB,
  input: { message: Message; emoji: string; userId: string; familyId: string },
): Promise<{ data: Message | null; error: DbError | null; legacy: boolean }> {
  const { data, error } = await settle(db.rpc('toggle_family_message_reaction', { p_message_id: input.message.id, p_emoji: input.emoji }));
  if (!fellBackForMissing(error, MESSAGING_SCHEMA.toggleReaction,
    'Reactions are a read-modify-write of the message, as before the build-out (a simultaneous reaction can be lost).')) {
    return { data, error, legacy: false };
  }
  return { ...(await legacyToggleReaction(db, input)), legacy: true };
}
