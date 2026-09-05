// Notification tools — the one way Bubaly interrupts a person.
//
// Risk is `medium` rather than `low` even though nothing is destroyed: a
// notification lands on someone's phone, cannot be recalled, and the whole
// family sees it. That is exactly the class §12 says a household should be
// able to hold behind "prepare" if it wants to, and the low tier's
// auto-execute would take that choice away.
//
// Recipients are resolved to people, never to raw user ids by the model:
// `audience` covers the two shapes a family thinks in ("everyone", "the
// grown-ups"), and named members are matched through the roster so a typo
// fails loudly instead of silently notifying nobody.
import 'server-only';
import { z } from 'zod';
import { notify, type NotifyRecipients } from '@/lib/services/notifications';
import { resolveMemberByName } from '@/lib/services/family';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import type { NotificationType } from '@/lib/database.types';
import { defineTool, plural, type ToolDefinition } from './types';

const NOTIFICATION_TYPES = [
  'chore_due', 'medication_due', 'calendar_event', 'school_event', 'sports_event',
  'maintenance_task', 'grocery_reminder', 'document_expiry', 'family_invite', 'system',
] as const;

export const notificationTools: ToolDefinition[] = [
  defineTool({
    name: 'notifications.notify',
    aliases: ['notify_family', 'send_notification'],
    description: 'Send a notification to the family, to the parents, or to named members.',
    domain: 'messaging',
    capability: 'create',
    risk: 'medium',
    readOnly: false,
    input: z.object({
      title: z.string().describe('The line people see first'),
      body: z.string().nullish(),
      audience: z.enum(['family', 'managers', 'members']).nullish().describe('Defaults to the whole family'),
      member_names: z.array(z.string()).nullish().describe('Used when audience is "members"'),
      member_ids: z.array(z.string()).nullish(),
      type: z.enum(NOTIFICATION_TYPES).nullish().describe('Defaults to "system"'),
      related_type: z.string().nullish(),
      related_id: z.string().nullish(),
      send_at: z.string().nullish().describe('Earliest delivery, ISO 8601. Quiet hours can push it later'),
      urgent: z.boolean().nullish().describe('Skip quiet hours — only for things that genuinely cannot wait'),
    }),
    output: z.object({
      created: z.number(),
      duplicates: z.number(),
      deferred: z.number(),
      skipped_member_ids: z.array(z.string()).describe('Managed profiles with no account to notify'),
    }),
    idempotencyFrom: (input) => `notifications.notify:${input.title.trim().toLowerCase()}:${input.related_id ?? ''}`,
    summarize: (input, output) => {
      if (output.created === 0) {
        return output.duplicates > 0
          ? `"${input.title}" was already waiting for everyone — not sent again`
          : `Nobody to notify about "${input.title}"`;
      }
      const deferred = output.deferred > 0 ? `, ${output.deferred} held until quiet hours end` : '';
      return `Told ${plural(output.created, 'person', 'people')}: ${input.title}${deferred}`;
    },
    consequences: (input) => [
      `Sends "${input.title}" to ${input.audience === 'managers' ? 'the parents' : input.audience === 'members' ? 'the people named' : 'everyone in the family'}.`,
      'A notification cannot be unsent once it lands.',
    ],
    execute: async (scope, input) => {
      let recipients: NotifyRecipients = 'family';
      if (input.audience === 'managers') recipients = 'managers';
      if (input.audience === 'members' || input.member_names?.length || input.member_ids?.length) {
        const ids = [...(input.member_ids ?? [])];
        for (const name of input.member_names ?? []) {
          const match = await resolveMemberByName(scope, name);
          if (!match.ok) return match;
          if (!match.data) return fail(`There is nobody called ${name} in this family.`, { code: SERVICE_CODES.notFound });
          ids.push(match.data.id);
        }
        if (ids.length === 0) return fail('Say who should be notified.', { code: SERVICE_CODES.invalidInput });
        recipients = ids;
      }

      const res = await notify(scope, {
        recipients,
        type: (input.type ?? 'system') as NotificationType,
        title: input.title,
        body: input.body ?? null,
        relatedType: input.related_type ?? null,
        relatedId: input.related_id ?? null,
        sendAt: input.send_at ?? null,
        urgent: input.urgent ?? false,
      });
      if (!res.ok) return res;
      return ok({
        created: res.data.created,
        duplicates: res.data.duplicates,
        deferred: res.data.deferred,
        skipped_member_ids: res.data.skippedMemberIds,
      });
    },
  }),
];
