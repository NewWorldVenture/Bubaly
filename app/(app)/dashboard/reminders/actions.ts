// The write path for reminders a person creates from a suggestion or an inbox
// item — and the fix for four one-tap buttons that could never have worked.
//
// `family_reminders` (0014) constrains two columns:
//
//   status   check (status in ('active','snoozed','completed','dismissed'))
//   priority check (priority in ('low','medium','high','urgent'))
//
// Four call sites wrote `status: 'pending'` and, on the non-urgent branch,
// `priority: 'normal'`. Neither value is in either set, so Postgres rejected the
// row with 23514 and NOTHING was ever written:
//
//   - front-desk-module   "turn a call action item into a family reminder"
//   - inbox-module        "action item → reminder (one tap)"
//   - autopilot-module    approving a "create reminder" suggestion
//   - paperwork actions   materialising a sign/pay/provide action
//
// Each shows the family an error and saves nothing. This is exactly the class of
// bug §7 is about: `createReminder` has always written a legal `status`, and maps
// an unrecognised priority onto the column default rather than sending it on, so
// the assistant's reminders worked while every one-tap button did not.
//
// DEPLOY COUPLING: `createReminder` names `idempotency_key`, which migration 0256
// adds — recorded in docs/PENDING_PROD_MIGRATIONS.md alongside the calendar and
// to-do tranches.
'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { createReminder, deleteReminder, snoozeReminder } from '@/lib/services/reminders';
import { makeKey } from '@/lib/services/idempotency';
import { dayKeyInTz, scopeFromUserContext, zonedTimeMs } from '@/lib/services/scope';
import { isSubmissionId } from '@/lib/utils/submission-id';
import { describeActionError } from '@/lib/supabase/errors';

const PATH = '/dashboard/reminders';

export type ReminderActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export type CreateReminderActionInput = {
  title: string;
  notes?: string | null;
  kind?: string;
  /**
   * One of `low` / `medium` / `high` / `urgent`. Anything else — including the
   * `normal` these call sites used to send — falls back to the column default
   * rather than being sent on to a CHECK that rejects the whole row.
   */
  priority?: string;
  remindAt?: string | null;
  /** `family_members.id` — who the reminder is about. */
  memberId?: string | null;
  aiSuggested?: boolean;
  /** Minted per composition in the browser; see `lib/utils/submission-id.ts`. */
  submissionId?: string;
};

/** The hour a timeless reminder lands on, in the family's own zone. */
const DEFAULT_REMINDER_HOUR = 9;

/**
 * When a surface gives no time, the next 9am in the family's zone.
 *
 * `createReminder` refuses a timeless reminder, and it is right to: `listDue`
 * filters `remind_at is not null`, so a reminder with no time never fires and
 * "silently never due" looks exactly like "its time has not come". The three
 * one-tap buttons that reach this action — a call action item, an inbox action
 * item, a quick-add suggestion — have no time to offer, so the choice is between
 * refusing them and picking a moment.
 *
 * Picking is better, and `now` is the wrong pick: a reminder created from an
 * action item is not something to be interrupted about this second. The next
 * morning is when a person would actually want to see it, and it is resolved in
 * `scope.tz` rather than the server's — 9am for the family, not 9am in UTC.
 */
function nextDefaultRemindAt(tz: string, now: Date): string {
  const today = dayKeyInTz(now, tz);
  const todayAt = zonedTimeMs(today, DEFAULT_REMINDER_HOUR, 0, tz);
  if (Number.isFinite(todayAt) && todayAt > now.getTime()) return new Date(todayAt).toISOString();

  const tomorrow = dayKeyInTz(new Date(now.getTime() + 24 * 3600_000), tz);
  const tomorrowAt = zonedTimeMs(tomorrow, DEFAULT_REMINDER_HOUR, 0, tz);
  // A zone name Intl cannot resolve must not cost the family their reminder.
  return new Date(Number.isFinite(tomorrowAt) ? tomorrowAt : now.getTime() + 24 * 3600_000).toISOString();
}

/**
 * The idempotency key for one save attempt, or null for "do not deduplicate".
 * Namespaced by operation; a missing or malformed id degrades to an
 * un-deduplicated write rather than failing the save.
 */
function submissionKey(familyId: string, submissionId: unknown): string | null {
  return isSubmissionId(submissionId) ? makeKey(['reminders.createReminder', familyId, submissionId]) : null;
}

export async function createReminderAction(input: CreateReminderActionInput): Promise<ReminderActionResult> {
  const t = await getTranslations();
  // Outside the try: `requireUserContext` redirects a signed-out caller by
  // throwing, and catching that would show them a toast instead.
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase, {
    idempotencyKey: submissionKey(ctx.active.familyId, input.submissionId),
  });

  try {
    const result = await createReminder(scope, {
      title: input.title ?? '',
      notes: input.notes ?? null,
      kind: input.kind,
      priority: input.priority,
      remindAt: input.remindAt ?? nextDefaultRemindAt(scope.tz, new Date()),
      memberId: input.memberId ?? null,
      aiSuggested: input.aiSuggested,
    });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[reminder-action] create failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotSetThatReminder')) };
  }
}

export async function deleteReminderAction(reminderId: string): Promise<ReminderActionResult> {
  const t = await getTranslations();
  if (!reminderId) return { ok: false, error: t('actions.thatReminderCouldNotBe') };
  // Outside the try: `requireUserContext` redirects by throwing.
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);

  try {
    const result = await deleteReminder(scope, reminderId);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[reminder-action] delete failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotRemoveThatReminder')) };
  }
}

/** Push a reminder out by `minutes` from now. */
export async function snoozeReminderAction(reminderId: string, minutes: number): Promise<ReminderActionResult> {
  const t = await getTranslations();
  if (!reminderId) return { ok: false, error: t('actions.thatReminderCouldNotBe') };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);

  try {
    const result = await snoozeReminder(scope, reminderId, minutes);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[reminder-action] snooze failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotSnoozeThatReminder')) };
  }
}
