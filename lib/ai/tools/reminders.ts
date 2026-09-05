// Reminder tools, writing to `family_reminders` — the table the reminders
// module, the toolbox and the concierge all read (decision D4).
//
// The legacy `complete_reminder` / `snooze_reminder` tools take a *partial
// title*, not an id, because that is how a person talks ("mark the vet thing
// done"). Keeping that shape means a title has to be resolved to a row before
// the service is called; `findReminder` does it here, family-scoped and
// failing closed, rather than pushing a fuzzy-match concern into the service
// layer where every other caller already has an id.
import 'server-only';
import { z } from 'zod';
import { completeReminder, createReminder, listDue, snoozeReminder } from '@/lib/services/reminders';
import { scopeNow } from '@/lib/services/scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import { resolveAssigneeId } from './family';
import { defineTool, describeWhen, plural, type ToolDefinition } from './types';

const KINDS = ['time', 'location', 'recurring', 'medication', 'bill', 'school', 'chore'] as const;
const RECURRENCES = ['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'] as const;
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

const reminderOutput = z.object({
  id: z.string(),
  title: z.string(),
  remind_at: z.string().nullable(),
  status: z.string(),
  recurrence: z.string(),
  priority: z.string(),
  member_id: z.string().nullable(),
  when: z.string(),
});

/**
 * Find the reminder a partial title refers to: the soonest still-live one that
 * matches. A read failure is fatal rather than "no match" — telling a family
 * their reminder does not exist when the database merely hiccuped is worse
 * than asking them to try again.
 */
async function findReminder(scope: ServiceScope, title: string): Promise<ServiceResult<{ id: string; title: string }>> {
  const term = title.trim().replace(/[%_]/g, (m) => `\\${m}`);
  if (!term) return fail('Which reminder did you mean?', { code: SERVICE_CODES.invalidInput });

  const { data, error } = await scope.db
    .from('family_reminders')
    .select('id, title')
    .eq('family_id', scope.familyId)
    .in('status', ['active', 'snoozed'])
    .ilike('title', `%${term}%`)
    .order('remind_at', { ascending: true, nullsFirst: false })
    .limit(1);
  if (error) {
    console.error('[tool:reminders] lookup failed', error);
    return fail(describeDbError(error, 'Could not look up that reminder.'), { code: SERVICE_CODES.db });
  }
  const row = data?.[0];
  if (!row) return fail(`No active reminder matching "${title}".`, { code: SERVICE_CODES.notFound });
  return ok(row);
}

export const reminderTools: ToolDefinition[] = [
  defineTool({
    name: 'reminders.create',
    aliases: ['add_reminder', 'create_reminder', 'remind_me'],
    description: 'Set a reminder that alerts the family at a time (or when they reach a place).',
    domain: 'scheduling',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      title: z.string(),
      remind_at: z.string().nullish().describe('ISO 8601 datetime to fire at'),
      notes: z.string().nullish(),
      kind: z.enum(KINDS).nullish(),
      recurrence: z.enum(RECURRENCES).nullish(),
      priority: z.enum(PRIORITIES).nullish(),
      location_name: z.string().nullish().describe('Required when kind is "location"'),
      assignee: z.string().nullish().describe('Family member this reminder is about'),
      assignee_id: z.string().nullish(),
    }),
    output: reminderOutput,
    idempotencyFrom: (input) => `reminders.create:${input.title.trim().toLowerCase()}:${input.remind_at ?? ''}`,
    summarize: (_input, output) => `Set a reminder: ${output.title}${output.when ? ` — ${output.when}` : ''}`,
    resource: (output) => ({ table: 'family_reminders', id: output.id }),
    execute: async (scope, input) => {
      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;

      const res = await createReminder(scope, {
        title: input.title,
        remindAt: input.remind_at ?? null,
        notes: input.notes ?? null,
        kind: input.kind ?? (input.recurrence && input.recurrence !== 'none' ? 'recurring' : 'time'),
        recurrence: input.recurrence ?? undefined,
        priority: input.priority ?? undefined,
        locationName: input.location_name ?? null,
        memberId: assignee.data,
      });
      if (!res.ok) return res;
      const reminder = res.data;
      return ok({
        id: reminder.id, title: reminder.title, remind_at: reminder.remind_at, status: reminder.status,
        recurrence: reminder.recurrence, priority: reminder.priority, member_id: reminder.member_id,
        when: reminder.remind_at ? describeWhen(reminder.remind_at, scope.tz, scopeNow(scope)) : '',
      });
    },
    verify: async (scope, _input, output) => {
      const { data, error } = await scope.db
        .from('family_reminders')
        .select('id, remind_at, status')
        .eq('id', output.id)
        .eq('family_id', scope.familyId)
        .maybeSingle();
      if (error) {
        console.error('[tool:reminders.create] verification read failed', error);
        return fail(describeDbError(error, 'Could not confirm the reminder was saved.'), { code: SERVICE_CODES.db });
      }
      // A reminder that exists but is not live will never fire, which is the
      // failure mode worth catching here.
      const live = Boolean(data) && (data!.status === 'active' || data!.status === 'snoozed');
      return ok({ verified: live, detail: live ? `"${output.title}" is set for ${output.when || 'its location'}.` : 'The reminder is not active.' });
    },
  }),

  defineTool({
    name: 'reminders.complete',
    aliases: ['complete_reminder', 'finish_reminder'],
    description: 'Mark a reminder done, by id or by part of its title. A repeating reminder rolls to its next occurrence.',
    domain: 'scheduling',
    capability: 'edit',
    risk: 'low',
    readOnly: false,
    input: z.object({
      reminder_id: z.string().nullish(),
      title: z.string().nullish().describe('Part of the reminder title, when the id is unknown'),
    }),
    output: reminderOutput,
    summarize: (_input, output) => (output.status === 'active'
      ? `Completed ${output.title} — next one set for ${output.when}`
      : `Completed ${output.title}`),
    resource: (output) => ({ table: 'family_reminders', id: output.id }),
    execute: async (scope, input) => {
      let id = input.reminder_id ?? null;
      if (!id) {
        if (!input.title) return fail('Say which reminder to complete.', { code: SERVICE_CODES.invalidInput });
        const found = await findReminder(scope, input.title);
        if (!found.ok) return found;
        id = found.data.id;
      }

      const res = await completeReminder(scope, id);
      if (!res.ok) return res;
      const reminder = res.data;
      return ok({
        id: reminder.id, title: reminder.title, remind_at: reminder.remind_at, status: reminder.status,
        recurrence: reminder.recurrence, priority: reminder.priority, member_id: reminder.member_id,
        when: reminder.remind_at ? describeWhen(reminder.remind_at, scope.tz, scopeNow(scope)) : '',
      });
    },
  }),

  defineTool({
    name: 'reminders.snooze',
    aliases: ['snooze_reminder', 'postpone_reminder'],
    description: 'Push a reminder out, by a number of minutes or to a specific time.',
    domain: 'scheduling',
    capability: 'edit',
    risk: 'low',
    readOnly: false,
    input: z.object({
      reminder_id: z.string().nullish(),
      title: z.string().nullish().describe('Part of the reminder title, when the id is unknown'),
      minutes: z.number().int().nullish().describe('How long to push it out'),
      remind_at: z.string().nullish().describe('Or an ISO 8601 time to move it to'),
    }),
    output: reminderOutput,
    summarize: (_input, output) => `Moved ${output.title} to ${output.when}`,
    resource: (output) => ({ table: 'family_reminders', id: output.id }),
    execute: async (scope, input) => {
      let id = input.reminder_id ?? null;
      if (!id) {
        if (!input.title) return fail('Say which reminder to move.', { code: SERVICE_CODES.invalidInput });
        const found = await findReminder(scope, input.title);
        if (!found.ok) return found;
        id = found.data.id;
      }

      // The service snoozes by a length from now; a caller-supplied absolute
      // time is converted here so both dialects reach one implementation.
      let minutes = input.minutes ?? null;
      if (minutes === null && input.remind_at) {
        const target = Date.parse(input.remind_at);
        if (!Number.isFinite(target)) return fail('That new time could not be understood.', { code: SERVICE_CODES.invalidInput });
        minutes = Math.round((target - scopeNow(scope).getTime()) / 60_000);
      }
      if (minutes === null) return fail('Say how long to snooze it for.', { code: SERVICE_CODES.invalidInput });
      if (minutes <= 0) return fail('A reminder can only be moved forward.', { code: SERVICE_CODES.invalidInput });

      const res = await snoozeReminder(scope, id, minutes);
      if (!res.ok) return res;
      const reminder = res.data;
      return ok({
        id: reminder.id, title: reminder.title, remind_at: reminder.remind_at, status: reminder.status,
        recurrence: reminder.recurrence, priority: reminder.priority, member_id: reminder.member_id,
        when: describeWhen(reminder.snoozed_until ?? reminder.remind_at, scope.tz, scopeNow(scope)),
      });
    },
  }),

  defineTool({
    name: 'reminders.listDue',
    aliases: ['list_due_reminders', 'list_reminders'],
    description: 'List reminders that are due now or within a horizon.',
    domain: 'scheduling',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      within_minutes: z.number().int().nullish().describe('Look ahead this far; defaults to now'),
      before: z.string().nullish().describe('Or an explicit ISO 8601 cutoff'),
      assignee: z.string().nullish(),
      assignee_id: z.string().nullish(),
      limit: z.number().int().nullish(),
    }),
    output: z.object({ reminders: z.array(reminderOutput) }),
    summarize: (_input, output) => (output.reminders.length === 0
      ? 'Nothing due'
      : `${plural(output.reminders.length, 'reminder')} due, starting with ${output.reminders[0].title}`),
    execute: async (scope, input) => {
      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;

      const res = await listDue(scope, {
        before: input.before ?? null,
        withinMinutes: input.within_minutes ?? undefined,
        memberId: assignee.data,
        limit: input.limit ?? undefined,
      });
      if (!res.ok) return res;
      const now = scopeNow(scope);
      return ok({
        reminders: res.data.map((reminder) => ({
          id: reminder.id, title: reminder.title, remind_at: reminder.remind_at, status: reminder.status,
          recurrence: reminder.recurrence, priority: reminder.priority, member_id: reminder.member_id,
          when: reminder.remind_at ? describeWhen(reminder.remind_at, scope.tz, now) : '',
        })),
      });
    },
  }),
];
