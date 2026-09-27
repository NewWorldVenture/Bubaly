// lib/dashboard/reminder-attention.ts — pure helper for surfacing reminders
// that need attention on the home dashboard. DOM-free + unit-testable.

export type AttentionReminderRow = { remind_at: string | null; status: string };

export type ReminderAttention = { overdue: number; dueToday: number };

/**
 * Split active, time-based reminders into:
 *  - `overdue`  — due time already passed
 *  - `dueToday` — due before `dayEndExclusiveMs`
 * Reminders without a time, or not `active`, are ignored. Bad timestamps are skipped.
 *
 * THE DAY END IS A PARAMETER BECAUSE THIS FUNCTION CANNOT KNOW IT. It used to
 * do `new Date(now); endOfToday.setHours(23, 59, 59, 999)`, which is the end of
 * the day in whatever zone the RUNTIME has — the server's, on Vercel UTC. Its
 * caller components/dashboard/ai-home-dashboard.tsx had already resolved the
 * FAMILY's day eleven lines earlier, with a comment saying so, and then handed
 * over a bare `now` for this to re-derive wrongly. One function, two different
 * "today": for a Tokyo family on a UTC server, "due later today" ran to 08:59
 * tomorrow morning, and the caller's seven-day query really does put those rows
 * in the input.
 *
 * REQUIRED, not optional with a fallback. A default is exactly what let the
 * weekly briefing ship Greenwich weeks for seven weeks: the one caller kept
 * compiling and kept being wrong. Making it required cost one line and named
 * every call site at the typechecker.
 *
 * EXCLUSIVE, because that is the shape `zonedDayBoundsMs` already returns —
 * the next local midnight, resolved across the 23- and 25-hour DST days. A
 * written-out 23:59:59.999 cannot promise that.
 */
export function reminderAttention(
  rows: AttentionReminderRow[], now: Date, dayEndExclusiveMs: number,
): ReminderAttention {
  const nowMs = now.getTime();

  let overdue = 0;
  let dueToday = 0;
  for (const r of rows) {
    if (r.status !== 'active' || !r.remind_at) continue;
    const t = new Date(r.remind_at).getTime();
    if (Number.isNaN(t)) continue;
    if (t < nowMs) overdue++;
    else if (t < dayEndExclusiveMs) dueToday++;
  }
  return { overdue, dueToday };
}
