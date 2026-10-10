// Which weekly occurrence a cron request belongs to, and the provider key that
// makes a repeat of it a no-op.
//
// The weekly email crons (chore-reminders, weekly-digest) are fired by TWO
// schedulers at the same minute: vercel.json, and the GitHub dispatcher whose
// SCHEDULES mirror it (scripts/cron-dispatch.mjs). A dispatcher tick that lands
// inside the five minutes after the slot calls the route again, Vercel may
// itself deliver an event more than once, and a run that answers 502 for one
// failed send invites a manual re-dispatch. Each of those used to email every
// recipient a second time: nothing recorded what had been sent.
//
// The occurrence is the SLOT — the most recent scheduled minute at or before
// the request — not the clock, so every tick for one slot names the same
// occurrence, exactly as admin-digest's does (lib/admin/digest-occurrence.ts).
// Each send carries one Resend idempotency key per recipient per occurrence:
// a repeat with the same bytes is answered with the original result and not
// sent again, a repeat with different bytes is refused (409
// invalid_idempotent_request, reported as a failed send — never as a second
// email), and a request still in flight answers 409 for the other. Resend holds
// a key for 24 hours, which covers every mirrored or retried tick of a slot;
// it is a fold at the provider, not a receipt, and a run more than a day after
// its slot is not deduplicated by it.
import { createHash } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A weekly cron expression `minute hour * * day`, in UTC (0 = Sunday). */
export type WeeklySchedule = { dayUtc: number; hourUtc: number; minuteUtc: number };

/** `0 18 * * 0` in vercel.json and scripts/cron-dispatch.mjs. */
export const CHORE_REMINDERS_SCHEDULE: WeeklySchedule = { dayUtc: 0, hourUtc: 18, minuteUtc: 0 };

/** `0 8 * * 1` in vercel.json and scripts/cron-dispatch.mjs. */
export const WEEKLY_DIGEST_SCHEDULE: WeeklySchedule = { dayUtc: 1, hourUtc: 8, minuteUtc: 0 };

/** The most recent firing of `schedule` at or before `now`. */
export function weeklySlot(now: Date, schedule: WeeklySchedule): Date {
  if (!Number.isFinite(now.getTime())) throw new TypeError('weeklySlot: now must be a valid date');
  const sameDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), schedule.hourUtc, schedule.minuteUtc);
  let slot = sameDay - ((now.getUTCDay() - schedule.dayUtc + 7) % 7) * DAY_MS;
  if (slot > now.getTime()) slot -= 7 * DAY_MS;
  return new Date(slot);
}

/**
 * One idempotency key per job, occurrence and recipient. `recipient` names the
 * email, not the address: a member of two families gets two different chore
 * emails and needs two keys. Hashed so no identifier reaches the provider.
 */
export function occurrenceSendKey(job: string, slot: Date, recipient: string): string {
  return `${job}/${createHash('sha256').update(`${job}|${slot.toISOString()}|${recipient}`).digest('hex')}`;
}
