// Reminders — written to `public.family_reminders` and nowhere else.
//
// The repo has two reminder tables. `public.reminders` (0002) is what the AI
// action layer, the autopilot executor and the briefing still write and read;
// `public.family_reminders` (0014) is what the reminders module, the toolbox
// and the concierge use. A reminder the assistant created was therefore
// invisible in the module the family actually opens. The implementation map's
// decision D4 makes `family_reminders` canonical: everything here writes
// there, and `public.reminders` stays in place as read-only legacy (the
// additive-only migration rule) until its readers are retargeted.
//
// Column ownership, verified against 0014: `created_by` and `assigned_to_id`
// reference `auth.users`, while `member_id` references `family_members`. A
// reminder for a managed child profile (no login) therefore carries
// `member_id` with a null `assigned_to_id` — which is why both are resolved
// separately instead of writing one id into both.
import 'server-only';
import { nextRemindAt } from '@/lib/reminders/details';
import type { Tables } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { keyedProbe, withIdempotency } from '../idempotency';
import { scopeNow } from '../scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type FamilyReminder = Tables<'family_reminders'>;

const KINDS = ['time', 'location', 'recurring', 'medication', 'bill', 'school', 'chore'];
const RECURRENCES = ['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export type CreateReminderInput = {
  title: string;
  remindAt?: string | null;
  notes?: string | null;
  kind?: string;
  recurrence?: string;
  priority?: string;
  /** `family_members.id` — who the reminder is about. */
  memberId?: string | null;
  /** `auth.users.id` — who gets pinged. Null for a managed profile. */
  assignedToUserId?: string | null;
  locationName?: string | null;
  tags?: string[];
  /** True when the assistant proposed this rather than a person asking for it. */
  aiSuggested?: boolean;
};

export async function createReminder(scope: ServiceScope, input: CreateReminderInput): Promise<ServiceResult<FamilyReminder>> {
  const title = input.title?.trim() ?? '';
  if (!title) return fail('A reminder needs a title.', { code: SERVICE_CODES.invalidInput });

  let remindAt: string | null = null;
  if (input.remindAt) {
    const ms = Date.parse(input.remindAt);
    if (!Number.isFinite(ms)) return fail('That reminder time could not be understood.', { code: SERVICE_CODES.invalidInput });
    remindAt = new Date(ms).toISOString();
  }

  const kind = input.kind && KINDS.includes(input.kind) ? input.kind : 'time';
  const recurrence = input.recurrence && RECURRENCES.includes(input.recurrence) ? input.recurrence : 'none';
  const priority = input.priority && PRIORITIES.includes(input.priority) ? input.priority : 'medium';

  // A location reminder without a place, or a time reminder without a time, is
  // a reminder that can never fire. Refuse it rather than storing a dud.
  if (kind === 'location' && !input.locationName?.trim()) {
    return fail('A location reminder needs a place.', { code: SERVICE_CODES.invalidInput });
  }
  // A RECURRING one needs a time just as much, and used to be exempt from this
  // check. `listDue` filters `remind_at is not null`, and `nextRemindAt` takes
  // the current `remind_at` as the point to count forward from — so a repeating
  // reminder with no first occurrence has neither a time to fire at nor a way
  // to compute one. "Remind me every day to stretch" reached `reminders.create`
  // with no `remind_at`, was stored, and never fired. Nothing surfaced it,
  // because a reminder that is silently never due looks exactly like one whose
  // time has not come.
  if (kind !== 'location' && !remindAt) {
    return fail('A reminder needs a time — even a repeating one needs its first occurrence.', { code: SERVICE_CODES.invalidInput });
  }

  return withIdempotency<FamilyReminder>(
    scope,
    {
      operation: 'reminders.createReminder',
      input: { title, remindAt, memberId: input.memberId ?? null },
      // 0256: the retried call finds the row it wrote, not a same-titled
      // reminder somebody set by hand at the same minute.
      find: keyedProbe(scope, 'family_reminders', 'reminder'),
    },
    async (key) => {
      const { data, error } = await scope.db
        .from('family_reminders')
        .insert({
          family_id: scope.familyId,
          title,
          notes: input.notes?.trim() || null,
          kind,
          remind_at: remindAt,
          location_name: input.locationName?.trim() || null,
          recurrence,
          priority,
          status: 'active',
          // created_by / assigned_to_id → auth.users; member_id → family_members.
          created_by: scope.userId,
          assigned_to_id: input.assignedToUserId ?? null,
          member_id: input.memberId ?? null,
          ai_suggested: input.aiSuggested ?? scope.actorKind === 'ai',
          tags: input.tags ?? [],
          idempotency_key: key,
        })
        .select('*')
        .single();
      if (error || !data) {
        console.error('[service:reminders] create failed', error);
        return fail(describeDbError(error, 'Could not set that reminder.'), { code: SERVICE_CODES.db });
      }

      await recordActivitySafely(scope, {
        agent: 'reminders',
        title: `Set a reminder: "${title}"`,
        detail: remindAt,
        href: '/dashboard/reminders',
        memberId: input.memberId ?? null,
      });
      return ok(data);
    },
  );
}

/**
 * Complete a reminder.
 *
 * A recurring reminder is not finished when it fires — it rolls forward to its
 * next occurrence and stays active, using `nextRemindAt`
 * (`lib/reminders/details.ts`), the same advance the module uses. Completing
 * it outright would silently cancel a daily medication reminder the first time
 * someone ticked it off.
 */
export async function completeReminder(scope: ServiceScope, reminderId: string): Promise<ServiceResult<FamilyReminder>> {
  const { data: existing, error: readError } = await scope.db
    .from('family_reminders')
    .select('id, recurrence, remind_at')
    .eq('id', reminderId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (readError) {
    console.error('[service:reminders] complete read failed', readError);
    return fail(describeDbError(readError, 'Could not load that reminder.'), { code: SERVICE_CODES.db });
  }
  if (!existing) return fail('That reminder could not be found.', { code: SERVICE_CODES.notFound });

  const now = scopeNow(scope).toISOString();
  const rollForward = existing.remind_at && existing.recurrence !== 'none'
    ? nextRemindAt(existing.remind_at, existing.recurrence)
    : null;

  const update = rollForward
    ? { status: 'active', remind_at: rollForward, snoozed_until: null, completed_at: now }
    : { status: 'completed', completed_at: now, snoozed_until: null };

  const { data, error } = await scope.db
    .from('family_reminders')
    .update(update)
    .eq('id', reminderId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[service:reminders] complete failed', error);
    return fail(describeDbError(error, 'Could not complete that reminder.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That reminder could not be found.', { code: SERVICE_CODES.notFound });
  return ok(data);
}

/** Push a reminder out by `minutes` from now (not from its original time). */
export async function snoozeReminder(scope: ServiceScope, reminderId: string, minutes: number): Promise<ServiceResult<FamilyReminder>> {
  const mins = Math.round(minutes);
  if (!Number.isFinite(mins) || mins <= 0) return fail('Snooze needs a length in minutes.', { code: SERVICE_CODES.invalidInput });

  const until = new Date(scopeNow(scope).getTime() + mins * 60_000).toISOString();
  const { data, error } = await scope.db
    .from('family_reminders')
    .update({ status: 'snoozed', snoozed_until: until })
    .eq('id', reminderId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[service:reminders] snooze failed', error);
    return fail(describeDbError(error, 'Could not snooze that reminder.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That reminder could not be found.', { code: SERVICE_CODES.notFound });
  return ok(data);
}

/**
 * Reminders that should fire by `before` (default: now).
 *
 * Snoozed reminders are included once their snooze has elapsed — the whole
 * point of a snooze is that it comes back — which is why the two statuses are
 * queried and then filtered rather than asking only for 'active'.
 */
export async function listDue(
  scope: ServiceScope,
  input: { before?: string | null; withinMinutes?: number; memberId?: string | null; limit?: number } = {},
): Promise<ServiceResult<FamilyReminder[]>> {
  const now = scopeNow(scope);
  const beforeMs = input.before
    ? Date.parse(input.before)
    : now.getTime() + (input.withinMinutes ?? 0) * 60_000;
  if (!Number.isFinite(beforeMs)) return fail('That horizon could not be understood.', { code: SERVICE_CODES.invalidInput });
  const beforeIso = new Date(beforeMs).toISOString();

  let query = scope.db
    .from('family_reminders')
    .select('*')
    .eq('family_id', scope.familyId)
    .in('status', ['active', 'snoozed'])
    .not('remind_at', 'is', null)
    .lte('remind_at', beforeIso)
    .order('remind_at', { ascending: true })
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
  if (input.memberId) query = query.eq('member_id', input.memberId);

  const { data, error } = await query;
  if (error) {
    console.error('[service:reminders] due read failed', error);
    return fail(describeDbError(error, 'Could not load your reminders.'), { code: SERVICE_CODES.db });
  }

  const due = (data ?? []).filter((row) => {
    if (row.status !== 'snoozed') return true;
    if (!row.snoozed_until) return true;
    const until = Date.parse(row.snoozed_until);
    return !Number.isFinite(until) || until <= beforeMs;
  });
  return ok(due);
}
