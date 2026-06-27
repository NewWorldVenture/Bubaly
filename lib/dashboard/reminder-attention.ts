// lib/dashboard/reminder-attention.ts — pure helper for surfacing reminders
// that need attention on the home dashboard. DOM-free + unit-testable.

export type AttentionReminderRow = { remind_at: string | null; status: string };

export type ReminderAttention = { overdue: number; dueToday: number };

/**
 * Split active, time-based reminders into:
 *  - `overdue`  — due time already passed
 *  - `dueToday` — due later today (up to end of the local day)
 * Reminders without a time, or not `active`, are ignored. Bad timestamps are skipped.
 */
export function reminderAttention(rows: AttentionReminderRow[], now: Date): ReminderAttention {
  const nowMs = now.getTime();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const endMs = endOfToday.getTime();

  let overdue = 0;
  let dueToday = 0;
  for (const r of rows) {
    if (r.status !== 'active' || !r.remind_at) continue;
    const t = new Date(r.remind_at).getTime();
    if (Number.isNaN(t)) continue;
    if (t < nowMs) overdue++;
    else if (t <= endMs) dueToday++;
  }
  return { overdue, dueToday };
}
