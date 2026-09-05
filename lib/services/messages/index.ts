// Family messages and announcements.
//
// `family_messages` (0014) hangs off `family_conversations`; a message needs a
// conversation, and "tell everyone" means the household's group chat. The
// messages module creates that chat lazily from the UI with `member_ids`
// (auth user ids — what the RLS read path checks) and `participant_ids`
// (`family_members.id`, added by 0017 so account-less kids and guests are
// still shown as participants). `ensureFamilyConversation` reproduces that
// exactly; the oldest un-archived group chat is THE family chat so the
// assistant and the UI never end up posting into two different "Family"
// threads.
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
import { recordActivitySafely } from '../activity';
import { getMember, getMembers } from '../family';
import { withIdempotency } from '../idempotency';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type FamilyMessage = Tables<'family_messages'>;
export type FamilyConversation = Tables<'family_conversations'>;
export type Announcement = Tables<'family_announcements'>;

export const FAMILY_CONVERSATION_NAME = 'Family';
const MESSAGE_KINDS = ['text', 'announcement'];
const MAX_MESSAGE_CHARS = 4000;

/** The household's group chat, created on first use with everyone in it. */
export async function ensureFamilyConversation(scope: ServiceScope): Promise<ServiceResult<{ id: string; created: boolean }>> {
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
  if (existing?.id) return ok({ id: existing.id, created: false });

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
  return ok({ id: data.id, created: true });
}

async function senderName(scope: ServiceScope): Promise<string> {
  if (!scope.memberId) return 'Bubaly';
  const member = await getMember(scope, scope.memberId);
  return member.ok ? member.data.displayName : 'Bubaly';
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

  let conversationId = input.conversationId ?? null;
  if (conversationId) {
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
  } else {
    const chat = await ensureFamilyConversation(scope);
    if (!chat.ok) return chat;
    conversationId = chat.data.id;
  }
  const targetId = conversationId;

  return withIdempotency<FamilyMessage>(
    scope,
    {
      operation: 'messages.sendFamilyMessage',
      input: { content, conversationId: targetId },
      find: async () => {
        // The same words in the same thread from the same sender within the
        // retry window is a retry, not a second message.
        const since = new Date((scope.now ?? new Date()).getTime() - 10 * 60_000).toISOString();
        let probe = scope.db
          .from('family_messages')
          .select('*')
          .eq('family_id', scope.familyId)
          .eq('conversation_id', targetId)
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
      },
    },
    async () => {
      const name = await senderName(scope);
      const { data, error } = await scope.db
        .from('family_messages')
        .insert({
          conversation_id: targetId,
          family_id: scope.familyId,
          // family_messages.sender_id references auth.users (0014).
          sender_id: scope.userId,
          sender_name: name,
          content,
          kind,
          reply_to_id: input.replyToId ?? null,
        })
        .select('*')
        .single();
      if (error || !data) {
        console.error('[service:messages] send failed', error);
        return fail(describeDbError(error, 'Could not send that message.'), { code: SERVICE_CODES.db });
      }
      await recordActivitySafely(scope, {
        agent: 'comms_assistant',
        title: `Sent to the family chat: ${content.length > 80 ? `${content.slice(0, 77)}…` : content}`,
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
        title: `Posted the announcement "${title}"`,
        detail: body,
        href: '/dashboard/announcements',
      });
      return ok(data);
    },
  );
}
