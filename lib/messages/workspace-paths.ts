// Missing messaging schema cannot preserve the family's chosen participant
// access or atomic actor checks. Return an honest error until those existing
// objects are available; never reinterpret an old group as the Family Chat.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { settle } from '@/lib/supabase/settle';
import type { summarizeConversations } from './overview';
import { readConversationInbox, readConversationOverview } from './reads';
import { isMissingSchemaObject, MESSAGING_SCHEMA, warnMissingMigration, type SchemaObject } from './schema-compat';
import type { LegacyConversationInsert } from './legacy-schema';

type DB = SupabaseClient<Database>;
type Conversation = Tables<'family_conversations'>;
type Message = Tables<'family_messages'>;
type DbError = { message: string; code?: string; details?: string; hint?: string };
export type ConversationSummaries = ReturnType<typeof summarizeConversations>;

const unavailable = (): DbError => ({ message: 'Messaging is temporarily unavailable. Please try again later.', code: 'messaging_schema_unavailable' });
function requiredSchemaError(error: DbError | null, object: SchemaObject): DbError | null {
  if (!isMissingSchemaObject(error, object)) return error;
  warnMissingMigration(object, 'Messaging remains unavailable until this required object exists; existing audiences and history are preserved.');
  return unavailable();
}

/** Only a verified canonical marker and the recorded audience admit an inbox row. */
export function inboxRows(data: readonly Conversation[] | null, viewer: { userId: string; selfMemberId: string | null | undefined }) {
  const legacy = Boolean(data?.some((row) => typeof row.is_family_chat !== 'boolean'));
  if (legacy) return { rows: null, legacy, error: unavailable() };
  const rows = (data ?? []).filter((row) => row.is_family_chat
    || row.participant_ids?.includes(viewer.selfMemberId ?? '') || row.member_ids?.includes(viewer.userId)
    || (!row.participant_ids?.length && !row.member_ids?.length && row.created_by === viewer.userId));
  return { rows, legacy, error: null };
}

export async function loadInbox(db: DB, input: { familyId: string; userId: string; selfMemberId: string | null | undefined }) {
  const { data, error } = await readConversationInbox(db, input.familyId);
  if (error) return { rows: null, legacy: false, error: requiredSchemaError(error, MESSAGING_SCHEMA.isFamilyChat) };
  return inboxRows(data, input);
}

/** An unavailable or unverified schema joins no presence channel. */
export type PresenceSchema = 'unknown' | 'legacy' | 'current';
export function presenceSchemaOf(inbox: { legacy: boolean; error?: unknown; rows?: readonly Conversation[] | null } | null): PresenceSchema {
  if (!inbox || inbox.legacy || inbox.error || inbox.rows === null) return 'unknown';
  return 'current';
}
export function presenceChannelConfig(schema: PresenceSchema, userId: string) {
  return schema === 'current' ? { private: true, presence: { key: userId } } : null;
}

/** Only the separate canonical Family Chat can be selected as the family chat. */
export function familyChatOf(rows: readonly Conversation[], legacy: boolean) {
  return legacy ? undefined : rows.find((conv) => conv.is_family_chat && !conv.is_archived);
}

export async function ensureFamilyChat(
  db: DB,
  input: { familyId: string; userId: string; name: string; members: ReadonlyArray<{ id: string; user_id: string | null }> },
): Promise<{ error: DbError | null; legacy: boolean }> {
  const { error } = await settle(db.rpc('ensure_family_conversation', { p_family_id: input.familyId }));
  return { error: requiredSchemaError(error, MESSAGING_SCHEMA.ensureFamilyConversation), legacy: false };
}

/** Validate membership and deduplicate direct chats in the existing atomic RPC. */
export async function createFamilyConversation(db: DB, payload: LegacyConversationInsert) {
  const res = await db.rpc('create_family_conversation', {
    p_family_id: payload.family_id, p_participant_ids: payload.participant_ids,
    p_name: payload.name, p_kind: payload.kind, p_avatar_emoji: payload.avatar_emoji ?? undefined,
  });
  return { ...res, error: requiredSchemaError(res.error, MESSAGING_SCHEMA.createFamilyConversation) };
}

/** Exact participant-authorized previews and unread counts; no family-wide scan. */
export async function loadConversationSummaries(
  db: DB,
  input: { familyId: string; userId: string },
): Promise<{ data: ConversationSummaries | null; error: DbError | null }> {
  const { data, error } = await readConversationOverview(db, input.familyId);
  if (error) return { data: null, error: requiredSchemaError(error, MESSAGING_SCHEMA.conversationOverview) };
  const next: ConversationSummaries = { lastByConv: new Map(), unreadByConv: new Map() };
  for (const row of data ?? []) {
    if (row.last_message) next.lastByConv.set(row.conversation_id, row.last_message as unknown as Message);
    next.unreadByConv.set(row.conversation_id, Number(row.unread_count));
  }
  return { data: next, error: null };
}

/** Missing atomic actor/audience revalidation never falls through to row updates. */
export async function markConversationReadThrough(
  db: DB,
  input: { conversationId: string; messageId: string; familyId: string; userId: string; rows: readonly Message[] },
): Promise<{ error: DbError | null; legacy: boolean; readIds?: string[] | null }> {
  const { error } = await settle(db.rpc('mark_conversation_read_through', { p_conversation_id: input.conversationId, p_message_id: input.messageId }));
  return { error: requiredSchemaError(error, MESSAGING_SCHEMA.markReadThrough), legacy: false };
}

/**
 * Whether `row` may be shown as read after markConversationReadThrough: with
 * `readIds`, exactly those rows; without, every row through `newest`.
 */
export function receiptLanded(
  row: { id: string; created_at: string },
  newest: { id: string; created_at: string },
  readIds: readonly string[] | null | undefined,
): boolean {
  if (readIds) return readIds.includes(row.id);
  return row.created_at < newest.created_at || (row.created_at === newest.created_at && row.id <= newest.id);
}

/** Only the atomic RPC may toggle the caller's reaction. */
export async function toggleMessageReaction(
  db: DB,
  input: { message: Message; emoji: string; userId: string; familyId: string },
): Promise<{ data: Message | null; error: DbError | null; legacy: boolean }> {
  const { data, error } = await settle(db.rpc('toggle_family_message_reaction', { p_message_id: input.message.id, p_emoji: input.emoji }));
  return { data, error: requiredSchemaError(error, MESSAGING_SCHEMA.toggleReaction), legacy: false };
}
