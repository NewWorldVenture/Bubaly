// Messaging tools: the family chat and the announcement board.
//
// Both are `medium` risk although each only inserts a row. A message cannot
// be unsent: everyone's phone buzzes the moment it lands, so a wrong one is
// a wrong one the whole family has read. That, and the `messaging` domain,
// is what puts these behind the family's Messages autonomy setting rather
// than the low-risk "just do it" tier that adding a to-do sits in.
//
// `create_announcement` is the legacy toolbox name; its `{title, body,
// pinned}` shape is accepted unchanged so stored approvals keep executing.
import 'server-only';
import { z } from 'zod';
import { createAnnouncement, sendFamilyMessage } from '@/lib/services/messages';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import { defineTool, type ToolDefinition } from './types';

/** A short quote of the message for summaries and approval cards. */
function excerpt(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export const messageTools: ToolDefinition[] = [
  defineTool({
    name: 'messages.sendFamilyMessage',
    aliases: ['send_family_message', 'message_family', 'send_message'],
    description: 'Send a message to the family group chat (or a specific conversation).',
    domain: 'messaging',
    capability: 'create',
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      content: z.string().nullish().describe('The message text'),
      message: z.string().nullish().describe('Alternative spelling of content'),
      conversation_id: z.string().nullish().describe('Omit to use the family group chat'),
      reply_to_id: z.string().nullish(),
    }),
    output: z.object({
      id: z.string(),
      conversation_id: z.string(),
      content: z.string(),
      sender_name: z.string().nullable(),
      sent_at: z.string(),
    }),
    idempotencyFrom: (input) => {
      const text = (input.content ?? input.message ?? '').trim().toLowerCase();
      return text ? `messages.sendFamilyMessage:${input.conversation_id ?? 'family'}:${text}` : null;
    },
    summarize: (_input, output) => `Sent to the family chat: "${excerpt(output.content)}"`,
    consequences: (input) => [`Everyone in the chat will see: "${excerpt(input?.content ?? input?.message ?? '', 120)}"`, 'A sent message cannot be unsent.'],
    resource: (output) => ({ table: 'family_messages', id: output.id }),
    execute: async (scope, input) => {
      const content = (input.content ?? input.message ?? '').trim();
      if (!content) return fail('What should the message say?', { code: SERVICE_CODES.invalidInput });
      const res = await sendFamilyMessage(scope, { content, conversationId: input.conversation_id ?? null, replyToId: input.reply_to_id ?? null });
      if (!res.ok) return res;
      const row = res.data;
      return ok({ id: row.id, conversation_id: row.conversation_id, content: row.content ?? content, sender_name: row.sender_name, sent_at: row.created_at });
    },
    verify: async (scope, _input, output) => {
      const { data, error } = await scope.db
        .from('family_messages')
        .select('id')
        .eq('family_id', scope.familyId)
        .eq('id', output.id)
        .maybeSingle();
      if (error) {
        console.error('[tool:messages.sendFamilyMessage] verification read failed', error);
        return fail(describeDbError(error, 'Could not confirm the message was sent.'), { code: SERVICE_CODES.db });
      }
      const found = Boolean(data);
      return ok({ verified: found, detail: found ? 'The message is in the chat.' : 'The message is not in the chat.' });
    },
  }),

  defineTool({
    name: 'messages.createAnnouncement',
    aliases: ['create_announcement', 'post_announcement'],
    description: 'Post a family announcement everyone sees on the board, optionally pinned to the top.',
    domain: 'messaging',
    capability: 'create',
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      title: z.string().describe('Headline'),
      body: z.string().nullish().describe('Details'),
      pinned: z.boolean().nullish().describe('Pin to the top of the board; defaults to false'),
    }),
    output: z.object({
      id: z.string(),
      title: z.string(),
      body: z.string().nullable(),
      pinned: z.boolean(),
      posted_at: z.string(),
    }),
    idempotencyFrom: (input) => {
      const title = input.title.trim().toLowerCase();
      return title ? `messages.createAnnouncement:${title}` : null;
    },
    summarize: (_input, output) => `Posted the announcement "${output.title}"${output.pinned ? ' and pinned it' : ''}`,
    consequences: (input) => [`Posts "${excerpt(input?.title ?? '', 100)}" where every family member sees it.`, ...(input?.pinned ? ['Pins it to the top of the board.'] : [])],
    resource: (output) => ({ table: 'family_announcements', id: output.id }),
    execute: async (scope, input) => {
      const res = await createAnnouncement(scope, { title: input.title, body: input.body ?? null, pinned: input.pinned ?? false });
      if (!res.ok) return res;
      const row = res.data;
      return ok({ id: row.id, title: row.title, body: row.body, pinned: row.is_pinned, posted_at: row.created_at });
    },
    verify: async (scope, _input, output) => {
      const { data, error } = await scope.db
        .from('family_announcements')
        .select('id')
        .eq('family_id', scope.familyId)
        .eq('id', output.id)
        .maybeSingle();
      if (error) {
        console.error('[tool:messages.createAnnouncement] verification read failed', error);
        return fail(describeDbError(error, 'Could not confirm the announcement was posted.'), { code: SERVICE_CODES.db });
      }
      const found = Boolean(data);
      return ok({ verified: found, detail: found ? `"${output.title}" is on the board.` : 'The announcement is not on the board.' });
    },
  }),
];
