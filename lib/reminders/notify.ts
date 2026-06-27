// lib/reminders/notify.ts — pure logic for deciding which family_reminders
// should produce a notification "now", honoring the early-reminder lead time.
// DOM-free + deterministic so the notification cron's timing is unit-testable.

export type FamilyReminderRow = {
  id: string;
  title: string;
  remind_at: string | null;
  status: string;
  early_reminder_minutes: number | null;
  member_id: string | null;
};

export type ReminderNotice = {
  id: string;
  title: string;
  /** The reminder's actual due time (for the notification body). */
  remindAtIso: string;
  /** When this notice becomes due = remind_at minus the early lead time. */
  effectiveAtIso: string;
};

const DAY_MS = 86_400_000;

/**
 * Reminders whose effective notify time (due time minus any early-reminder
 * lead) falls within the catch-up window starting now. Mirrors the legacy
 * `reminders` heads-up model (a single notification per item; the cron runs a
 * few times a day and the caller dedups permanently by id).
 */
export function dueFamilyReminderNotices(
  rows: FamilyReminderRow[],
  now: Date,
  windowMs: number = DAY_MS,
): ReminderNotice[] {
  const start = now.getTime();
  const out: ReminderNotice[] = [];
  for (const r of rows) {
    if (r.status !== 'active' || !r.remind_at) continue;
    const due = Date.parse(r.remind_at);
    if (Number.isNaN(due)) continue;
    const lead = r.early_reminder_minutes != null && r.early_reminder_minutes >= 0 ? r.early_reminder_minutes * 60_000 : 0;
    const effective = due - lead;
    if (effective >= start && effective <= start + windowMs) {
      out.push({ id: r.id, title: r.title, remindAtIso: r.remind_at, effectiveAtIso: new Date(effective).toISOString() });
    }
  }
  return out;
}

/**
 * The widest `remind_at` upper bound to fetch so the early-reminder lead time is
 * covered: the window plus the largest plausible lead (1 week).
 */
export function reminderFetchHorizonIso(now: Date, windowMs: number = DAY_MS): string {
  return new Date(now.getTime() + windowMs + 7 * DAY_MS).toISOString();
}
