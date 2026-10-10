// lib/autopilot/reminder-time.ts — when an Autopilot reminder may actually fire.
//
// The reminder notifier only selects rows whose `remind_at` is still ahead of
// it (lib/server/notifications.ts: `remind_at >= now`). A reminder written with
// an instant that has already passed — 09:00 today for a family whose 09:00 was
// hours ago, an overdue refill's morning, a renewal "due today" accepted in the
// afternoon — is stored, stamped "handled", and never delivered.
//
// Pure, so the scan, the accept path and the tests share one answer.
import { dayKeyInZone, zonedTimeMs } from '@/lib/schedule/zoned';

/** A reminder must be at least this far ahead of now to count as still to come. */
export const REMINDER_LEAD_MS = 5 * 60_000;

function addDays(dayKey: string, days: number): string {
  const ms = Date.parse(`${dayKey}T00:00:00Z`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * `at` when it is still ahead of `now`; otherwise the family's next 09:00 that
 * is. Never returns an instant in the past.
 */
export function deliverableReminderIso(at: string | null | undefined, now: Date, tz: string): string {
  const nowMs = now.getTime();
  const atMs = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  if (typeof at === 'string' && Number.isFinite(atMs) && atMs > nowMs + REMINDER_LEAD_MS) return at;
  const today = dayKeyInZone(nowMs, tz) ?? new Date(nowMs).toISOString().slice(0, 10);
  for (let i = 0; i <= 2; i++) {
    const ms = zonedTimeMs(addDays(today, i), 9, 0, tz);
    if (Number.isFinite(ms) && ms > nowMs + REMINDER_LEAD_MS) return new Date(ms).toISOString();
  }
  return new Date(nowMs + REMINDER_LEAD_MS * 2).toISOString();
}
