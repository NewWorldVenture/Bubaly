// Family messages and announcements.
//
// `family_messages` (0014) hangs off `family_conversations`; a message needs a
// conversation, and "tell everyone" means the household's group chat. The
// canonical RPC creates a separate, empty chat. Existing groups retain their
// recorded audiences and history; neither their names nor their current roster
// identifies them as the canonical Family Chat. Elevated executors also use
// the atomic send RPC, which locks and revalidates the actor and audience.
//
// Missing 0475 objects return their database error. A legacy schema cannot
// preserve the explicitly chosen empty Family Chat or atomically revalidate
// membership and audiences, so it must not adopt groups, read old history,
// or retry the failed RPC as a direct write.
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
import { ROLE_ORDER } from '@/lib/constants/roles';
import type { Tables } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { getMember, type FamilyMember } from '../family';
import { sameId, withIdempotency } from '../idempotency';
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
  if (error || !data) {
    console.error('[service:messages] conversation create failed', error);
    return fail(describeDbError(error, 'Could not open the family chat.'), { code: SERVICE_CODES.db });
  }
  return ok({ id: data });
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
  // The actor gate is not a 0475 object and stays on every schema: the
  // previous build also sent for a scope without an active member (signing as
  // Bubaly), which this hardening deliberately refuses, before or after 0475.
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
      const { data, error } = await scope.db.rpc('send_family_message', {
        p_family_id: scope.familyId, p_conversation_id: targetId,
        p_member_id: scope.memberId, p_user_id: scope.userId,
        p_content: content, p_kind: kind, p_reply_to_id: replyToId, p_idempotency_key: key,
      });
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

export type CreateAnnouncementInput = { title: string; body?: string | null; pinned?: boolean };

export async function createAnnouncement(scope: ServiceScope, input: CreateAnnouncementInput): Promise<ServiceResult<Announcement>> {
  const title = input.title?.trim() ?? '';
  if (!title) return fail('An announcement needs a headline.', { code: SERVICE_CODES.invalidInput });
  if (title.length > 200) return fail('Keep the headline under 200 characters and put the rest in the body.', { code: SERVICE_CODES.invalidInput });
  const body = input.body?.trim() || null;
  if (body && body.length > MAX_MESSAGE_CHARS) return fail('That announcement is too long.', { code: SERVICE_CODES.invalidInput });

  // Executor scopes may be cached while membership or authority changes.
  // Recheck the exact actor before both posting and returning keyed history;
  // a service client bypasses RLS. This read does not lock the later write.
  const ownerlessSystem = scope.actorKind === 'system' && scope.role === 'system'
    && scope.userId === null && scope.memberId === null;
  if (!ownerlessSystem) {
    if (!scope.userId || !scope.memberId) {
      return fail('A signed-in family member is required to post an announcement.', { code: SERVICE_CODES.denied });
    }
    const { data: actor, error } = await scope.db.from('family_members')
      .select('id,family_id,user_id,is_active,role')
      .eq('id', scope.memberId).eq('family_id', scope.familyId).maybeSingle();
    if (error) return fail(describeDbError(error, 'Could not verify your family membership.'), { code: SERVICE_CODES.db });
    if (!actor || actor.id !== scope.memberId || actor.family_id !== scope.familyId
      || actor.user_id !== scope.userId || actor.is_active !== true) {
      return fail('Your family membership is no longer active.', { code: SERVICE_CODES.denied });
    }
    if (!ROLE_ORDER.includes(actor.role) || actor.role !== scope.role) {
      return fail('Your family role changed. Start a new request to post an announcement.', { code: SERVICE_CODES.denied });
    }
  }

  return withIdempotency<Announcement>(
    scope,
    {
      operation: 'messages.createAnnouncement',
      input: { title, body },
      changedRetry: {
        drift: (found) => [
          ...(!sameId(found.author_id, scope.userId) ? ['author_id'] : []),
          ...(!sameId(found.author_member_id, scope.memberId) ? ['author_member_id'] : []),
        ],
        message: () => 'An existing announcement with this headline does not match this request\'s author. Review the announcements before trying again.',
        id: (found) => found.id,
      },
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
