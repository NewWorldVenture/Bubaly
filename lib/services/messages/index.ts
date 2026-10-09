// Family messages and announcements.
//
// `family_messages` (0014) hangs off `family_conversations`; a message needs a
// conversation, and "tell everyone" means the household's group chat. The
// canonical RPC creates a separate, empty chat. Existing groups retain their
// recorded audiences and history; neither their names nor their current roster
// identifies them as the canonical Family Chat. Elevated executors also use
// the atomic send RPC, which locks and revalidates the actor and audience.
//
// On a database without 0475 (lib/messages/schema-compat.ts) each of those
// paths does what the previous production build did, with one console warning
// naming the migration: the oldest un-archived group chat is the family chat
// (created with every member when there is none), an addressed conversation
// only has to exist in the family (that schema's RLS is family-wide), a retry
// is the same words in the same thread from the same sender within ten
// minutes, and the message is a direct insert. Only the exact missing-object
// answer selects a fallback; every other error is reported as before.
//
// `family_announcements` (0046) carries both `author_id` (auth.users) and
// `author_member_id` (family_members). The legacy toolbox filled only the
// member id — and picked `ctx.members[0]`, i.e. whoever happened to be first
// in the roster, not the person asking. Both columns are set here from the
// scope so an announcement is attributed to the person it came from.
//
// `sender_name` is the acting member's name even when the assistant sends the
// message: the person approved it and the family reads it as theirs. Only a
// system actor with nobody behind it signs as Bubaly.
import 'server-only';
import type { Tables } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { fellBackForMissing, MESSAGING_SCHEMA } from '@/lib/messages/schema-compat';
import { recordActivitySafely } from '../activity';
import { getMember, getMembers, type FamilyMember } from '../family';
import { withIdempotency } from '../idempotency';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type FamilyMessage = Tables<'family_messages'>;
export type FamilyConversation = Tables<'family_conversations'>;
export type Announcement = Tables<'family_announcements'>;

export const FAMILY_CONVERSATION_NAME = 'Family';
const MESSAGE_KINDS = ['text', 'announcement'];
const MAX_MESSAGE_CHARS = 4000;

/** Open the canonical chat without adopting or modifying a legacy group. */
export async function ensureFamilyConversation(scope: ServiceScope): Promise<ServiceResult<{ id: string }>> {
  const actor = await actingMember(scope);
  if (!actor.ok) return actor;
  return openFamilyConversation(scope);
}

async function openFamilyConversation(scope: ServiceScope): Promise<ServiceResult<{ id: string }>> {
  const { data, error } = await scope.db.rpc('ensure_family_conversation', {
    p_family_id: scope.familyId, p_member_id: scope.memberId, p_user_id: scope.userId,
  });
  if (fellBackForMissing(error, MESSAGING_SCHEMA.ensureFamilyConversation,
    'The oldest un-archived group chat is the family chat, created with every member when there is none, as before the build-out.')) {
    return legacyFamilyConversation(scope);
  }
  if (error || !data) {
    console.error('[service:messages] conversation create failed', error);
    return fail(describeDbError(error, 'Could not open the family chat.'), { code: SERVICE_CODES.db });
  }
  return ok({ id: data });
}

/** The previous production ensureFamilyConversation, for a database without 0475. */
async function legacyFamilyConversation(scope: ServiceScope): Promise<ServiceResult<{ id: string }>> {
  const { data: existing, error: lookupError } = await scope.db
    .from('family_conversations')
    .select('id')
    .eq('family_id', scope.familyId)
    .eq('kind', 'group')
    .eq('is_archived', false)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (lookupError) {
    console.error('[service:messages] conversation lookup failed', lookupError);
    return fail(describeDbError(lookupError, 'Could not open the family chat.'), { code: SERVICE_CODES.db });
  }
  if (existing?.id) return ok({ id: existing.id });

  const members = await getMembers(scope);
  if (!members.ok) return members;
  const { data, error } = await scope.db
    .from('family_conversations')
    .insert({
      family_id: scope.familyId,
      name: FAMILY_CONVERSATION_NAME,
      kind: 'group',
      avatar_emoji: '👨‍👩‍👧‍👦',
      member_ids: members.data.map((m) => m.userId).filter((id): id is string => Boolean(id)),
      participant_ids: members.data.map((m) => m.id),
      // family_conversations.created_by references auth.users (0014).
      created_by: scope.userId,
    })
    .select('id')
    .single();
  if (error || !data) {
    console.error('[service:messages] conversation create failed', error);
    return fail(describeDbError(error, 'Could not start the family chat.'), { code: SERVICE_CODES.db });
  }
  return ok({ id: data.id });
}

async function actingMember(scope: ServiceScope): Promise<ServiceResult<FamilyMember | null>> {
  if (!scope.userId) {
    return scope.actorKind === 'system' && scope.role === 'system' && !scope.memberId
      ? ok(null)
      : fail('A signed-in family member is required to send a message.', { code: SERVICE_CODES.denied });
  }
  if (!scope.memberId) return fail('Your family membership could not be verified.', { code: SERVICE_CODES.denied });
  const member = await getMember(scope, scope.memberId);
  if (!member.ok) return member;
  if (!member.data.isActive || member.data.userId !== scope.userId) {
    return fail('Your family membership is no longer active.', { code: SERVICE_CODES.denied });
  }
  return member;
}

/** The conversation a send names must be this family's, open, and the actor's. */
async function addressedConversation(scope: ServiceScope, actor: FamilyMember | null, conversationId: string): Promise<ServiceResult<null>> {
  const { data, error } = await scope.db
    .from('family_conversations')
    .select('id,is_family_chat,is_archived,member_ids,participant_ids,created_by')
    .eq('family_id', scope.familyId)
    .eq('id', conversationId)
    .maybeSingle();
  if (fellBackForMissing(error, MESSAGING_SCHEMA.isFamilyChat,
    'A conversation only has to exist in the family, as before the build-out (that schema\'s RLS is family-wide).')) {
    return legacyConversationExists(scope, conversationId);
  }
  if (error) {
    console.error('[service:messages] conversation read failed', error);
    return fail(describeDbError(error, 'Could not open that conversation.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That conversation could not be found.', { code: SERVICE_CODES.notFound });
  if (data.is_archived) return fail('That conversation is archived.', { code: SERVICE_CODES.denied });
  const participates = actor && (data.participant_ids.includes(actor.id)
    || data.member_ids.includes(scope.userId!)
    || (!data.participant_ids.length && !data.member_ids.length && data.created_by === scope.userId));
  if (!data.is_family_chat && !participates) {
    return fail('You are not a participant in that conversation.', { code: SERVICE_CODES.denied });
  }
  return ok(null);
}

/** The previous production conversation read: it only had to exist in the family. */
async function legacyConversationExists(scope: ServiceScope, conversationId: string): Promise<ServiceResult<null>> {
  const { data, error } = await scope.db
    .from('family_conversations')
    .select('id')
    .eq('family_id', scope.familyId)
    .eq('id', conversationId)
    .maybeSingle();
  if (error) {
    console.error('[service:messages] conversation read failed', error);
    return fail(describeDbError(error, 'Could not open that conversation.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That conversation could not be found.', { code: SERVICE_CODES.notFound });
  return ok(null);
}

export type SendMessageInput = {
  content: string;
  /** Defaults to the family group chat. */
  conversationId?: string | null;
  kind?: string;
  replyToId?: string | null;
};

export async function sendFamilyMessage(scope: ServiceScope, input: SendMessageInput): Promise<ServiceResult<FamilyMessage>> {
  const content = input.content?.trim() ?? '';
  if (!content) return fail('A message needs some text.', { code: SERVICE_CODES.invalidInput });
  if (content.length > MAX_MESSAGE_CHARS) return fail('That message is too long for the family chat.', { code: SERVICE_CODES.invalidInput });
  const kind = input.kind && MESSAGE_KINDS.includes(input.kind) ? input.kind : 'text';
  const actor = await actingMember(scope);
  if (!actor.ok) return actor;

  let conversationId = input.conversationId ?? null;
  if (conversationId) {
    const addressed = await addressedConversation(scope, actor.data, conversationId);
    if (!addressed.ok) return addressed;
  } else {
    const chat = await openFamilyConversation(scope);
    if (!chat.ok) return chat;
    conversationId = chat.data.id;
  }
  const targetId = conversationId;
  const replyToId = input.replyToId ?? null;
  if (replyToId) {
    const { data, error } = await scope.db.from('family_messages').select('id')
      .eq('family_id', scope.familyId).eq('conversation_id', targetId)
      .eq('id', replyToId).is('deleted_at', null).maybeSingle();
    if (error) return fail(describeDbError(error, 'Could not check the message being replied to.'), { code: SERVICE_CODES.db });
    if (!data) return fail('The message being replied to is no longer available in this conversation.', { code: SERVICE_CODES.notFound });
  }

  return withIdempotency<FamilyMessage>(
    scope,
    {
      operation: 'messages.sendFamilyMessage',
      input: { content, conversationId: targetId, kind, replyToId },
      find: async (key) => {
        // A durable operation key identifies the retry. The
        // RPC revalidates the actor under a lock even for service-role reads;
        // a removal after the preliminary read cannot return private history.
        const since = new Date((scope.now ?? new Date()).getTime() - 10 * 60_000).toISOString();
        const { data, error } = await scope.db.rpc('find_family_message', {
          p_family_id: scope.familyId, p_conversation_id: targetId,
          p_member_id: scope.memberId, p_user_id: scope.userId,
          p_content: content, p_kind: kind, p_reply_to_id: replyToId, p_since: since, p_idempotency_key: key,
        });
        if (fellBackForMissing(error, MESSAGING_SCHEMA.findFamilyMessage,
          'A retried send is recognised by the same words in the same thread from the same sender within ten minutes, as before the build-out.')) {
          return legacyDuplicateProbe(scope, targetId, content, since);
        }
        if (error) {
          console.error('[service:messages] duplicate probe failed', error);
          return fail(describeDbError(error, 'Could not check for a duplicate message.'), { code: SERVICE_CODES.db });
        }
        return ok(data?.[0] ?? null);
      },
      changedRetry: {
        drift: (found) => [
          ...(found.conversation_id !== targetId ? ['conversation_id'] : []),
          ...(found.content !== content ? ['content'] : []),
          ...(found.kind !== kind ? ['kind'] : []),
          ...(found.reply_to_id !== replyToId ? ['reply_to_id'] : []),
          ...(found.deleted_at ? ['deleted_at'] : []),
        ],
        message: () => 'This send was already saved with different content or was deleted. Start a new message to send again.',
        id: (found) => found.id,
      },
    },
    async (key) => {
      // The actor read above gives useful errors; the RPC rechecks it under a
      // membership lock in the same transaction as INSERT, including service
      // clients that bypass RLS. Missing RPC/schema errors never retry a raw insert.
      let { data, error } = await scope.db.rpc('send_family_message', {
        p_family_id: scope.familyId, p_conversation_id: targetId,
        p_member_id: scope.memberId, p_user_id: scope.userId,
        p_content: content, p_kind: kind, p_reply_to_id: replyToId, p_idempotency_key: key,
      });
      if (fellBackForMissing(error, MESSAGING_SCHEMA.sendFamilyMessage,
        'The message is a direct insert into family_messages, as before the build-out.')) {
        ({ data, error } = await legacySend(scope, { conversationId: targetId, senderName: actor.data?.displayName ?? 'Bubaly', content, kind, replyToId }));
      }
      if (error || !data) {
        console.error('[service:messages] send failed', error);
        return fail(describeDbError(error, 'Could not send that message.'), { code: SERVICE_CODES.db });
      }
      await recordActivitySafely(scope, {
        agent: 'comms_assistant',
        action: 'send',
        title: 'Sent a message',
        href: '/dashboard/messages',
      });
      return ok(data);
    },
  );
}

/** The previous production duplicate probe: same words, same thread, same sender, within the window. */
async function legacyDuplicateProbe(scope: ServiceScope, conversationId: string, content: string, since: string): Promise<ServiceResult<FamilyMessage | null>> {
  let probe = scope.db
    .from('family_messages')
    .select('*')
    .eq('family_id', scope.familyId)
    .eq('conversation_id', conversationId)
    .eq('content', content)
    .gte('created_at', since)
    .is('deleted_at', null)
    .limit(1);
  probe = scope.userId ? probe.eq('sender_id', scope.userId) : probe.is('sender_id', null);
  const { data, error } = await probe.maybeSingle();
  if (error) {
    console.error('[service:messages] duplicate probe failed', error);
    return fail(describeDbError(error, 'Could not check for a duplicate message.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? null);
}

/** The previous production send: a direct insert of the message row. */
function legacySend(scope: ServiceScope, input: { conversationId: string; senderName: string; content: string; kind: string; replyToId: string | null }) {
  return scope.db
    .from('family_messages')
    .insert({
      conversation_id: input.conversationId,
      family_id: scope.familyId,
      // family_messages.sender_id references auth.users (0014).
      sender_id: scope.userId,
      sender_name: input.senderName,
      content: input.content,
      kind: input.kind,
      reply_to_id: input.replyToId,
    })
    .select('*')
    .single();
}

export type CreateAnnouncementInput = { title: string; body?: string | null; pinned?: boolean };

export async function createAnnouncement(scope: ServiceScope, input: CreateAnnouncementInput): Promise<ServiceResult<Announcement>> {
  const title = input.title?.trim() ?? '';
  if (!title) return fail('An announcement needs a headline.', { code: SERVICE_CODES.invalidInput });
  if (title.length > 200) return fail('Keep the headline under 200 characters and put the rest in the body.', { code: SERVICE_CODES.invalidInput });
  const body = input.body?.trim() || null;
  if (body && body.length > MAX_MESSAGE_CHARS) return fail('That announcement is too long.', { code: SERVICE_CODES.invalidInput });

  return withIdempotency<Announcement>(
    scope,
    {
      operation: 'messages.createAnnouncement',
      input: { title, body },
      find: async () => {
        const since = new Date((scope.now ?? new Date()).getTime() - 24 * 3600_000).toISOString();
        const { data, error } = await scope.db
          .from('family_announcements')
          .select('*')
          .eq('family_id', scope.familyId)
          .eq('title', title)
          .gte('created_at', since)
          .limit(1)
          .maybeSingle();
        if (error) {
          console.error('[service:messages] duplicate announcement probe failed', error);
          return fail(describeDbError(error, 'Could not check for a duplicate announcement.'), { code: SERVICE_CODES.db });
        }
        return ok(data ?? null);
      },
    },
    async () => {
      const { data, error } = await scope.db
        .from('family_announcements')
        .insert({
          family_id: scope.familyId,
          title,
          body,
          is_pinned: input.pinned ?? false,
          // author_id → auth.users, author_member_id → family_members (0046).
          author_id: scope.userId,
          author_member_id: scope.memberId,
        })
        .select('*')
        .single();
      if (error || !data) {
        console.error('[service:messages] announcement create failed', error);
        return fail(describeDbError(error, 'Could not post that announcement.'), { code: SERVICE_CODES.db });
      }
      await recordActivitySafely(scope, {
        agent: 'comms_assistant',
        action: 'create',
        title: `Posted the announcement "${title}"`,
        detail: body,
        href: '/dashboard/announcements',
      });
      return ok(data);
    },
  );
}
