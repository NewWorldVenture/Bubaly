// Which weekly occurrence a cron tick belongs to.
//
// Two schedulers drive the same routes (vercel.json and scripts/cron-dispatch.mjs;
// tests/a-mirrored-cron-must-be-idempotent.test.ts), a GitHub tick can land a
// few minutes late, and a route can be re-run by hand after a 502. A weekly
// email that derives its window from the clock renders different bytes on every
// tick and carries no key, so each caller sends its own copy. The admin digest
// settled this for the daily shape (lib/admin/digest-occurrence.ts): an
// occurrence is the most recent scheduled slot at or before "now", every tick
// in the slot names the same occurrence, renders the same window and sends
// under one idempotency key per recipient, which the provider folds. This is
// the weekly form of the same rule, for the chore reminders ('0 18 * * 0') and
// the weekly digest ('0 8 * * 1'). The schedule strings live in vercel.json and
// the dispatcher's SCHEDULES; the constants here must agree with them, and
// tests/a-weekly-email-is-sent-once-per-slot-whoever-calls.test.ts pins that.

const DAY_MS = 24 * 60 * 60 * 1000;

/** A `m h * * d` cron: one fire a week, in UTC. */
export type WeeklySlot = { weekdayUtc: number; hourUtc: number; minuteUtc: number };

/** `/api/cron/chore-reminders`: `0 18 * * 0`. */
export const CHORE_REMINDER_SLOT: WeeklySlot = { weekdayUtc: 0, hourUtc: 18, minuteUtc: 0 };
/** `/api/cron/weekly-digest`: `0 8 * * 1`. */
export const WEEKLY_DIGEST_SLOT: WeeklySlot = { weekdayUtc: 1, hourUtc: 8, minuteUtc: 0 };

/** The cron expression a weekly slot stands for, to compare with the schedules. */
export function weeklySlotCron(slot: WeeklySlot): string {
  return `${slot.minuteUtc} ${slot.hourUtc} * * ${slot.weekdayUtc}`;
}

/** The most recent fire of `slot` at or before `now`, as the instant it names. */
export function lastWeeklySlot(now: Date, slot: WeeklySlot): Date {
  if (!Number.isFinite(now.getTime())) throw new TypeError('cron slot: now must be a valid date');
  const sameDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), slot.hourUtc, slot.minuteUtc);
  const daysBack = (now.getUTCDay() - slot.weekdayUtc + 7) % 7;
  let at = sameDay - daysBack * DAY_MS;
  // Same weekday, but the hour has not come yet: last week's.
  if (at > now.getTime()) at -= 7 * DAY_MS;
  return new Date(at);
}

/** The week a weekly slot covers: from the slot to the next one. */
export function weeklyWindow(slot: Date): { start: string; end: string } {
  return { start: slot.toISOString(), end: new Date(slot.getTime() + 7 * DAY_MS).toISOString() };
}
