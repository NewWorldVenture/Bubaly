// Marketplace rent/borrow returns — pure engine, no I/O.
//
// Turns an order's due date (ends_on) into a return status the Orders page and
// the return-reminders cron both read. Fully tested; the cron's dedupe stamps
// live in the DB, this only computes the human-facing state.
//
// ── The unit is a DAY KEY, not an instant ───────────────────────────────────
//
// "Due today" and "overdue" are calendar-day judgements, and these took
// `now: Date = new Date()` and found midnight with `setHours(0, 0, 0, 0)` — the
// HOST's midnight. On a UTC server that is 5pm in California, so the Orders page
// spent the last seven hours of every day telling a family an item due TODAY was
// "Overdue by 1 day" and one due tomorrow was "Due today".
//
// The cron is the same defect with teeth. It is cross-family — one query, no
// family filter, every household in one batch — so a single host day decided the
// due date for all of them at once. And its dedupe stamps are ONE-SHOT:
// `due_reminder_sent_at` and `overdue_notified_at` are set the first time and
// never cleared, and an overdue alert `continue`s past the due-soon nudge. So a
// reminder sent against the wrong day is not merely early; it SPENDS the only
// notification that order will ever get. A family told "Overdue by 1 day" on the
// morning it is actually due never receives the "Due today" nudge at all.
//
// Taking a `todayKey` removes the zone from this module: both dates are parsed
// as UTC midnights, which is not a claim that anyone is in UTC — it is how two
// calendar days are subtracted with no zone entering into it. Each caller
// answers "which day is it" where it holds the family's zone to answer with.

export type ReturnStatus = 'not_applicable' | 'returned' | 'upcoming' | 'due_soon' | 'due_today' | 'overdue';

const DAY = 86400_000;

/**
 * Whole days from `todayKey` to the due date (negative = already overdue).
 *
 * Both are `YYYY-MM-DD` and both are parsed as UTC midnight, so the subtraction
 * is exact whole days with no host clock left to be wrong about.
 */
export function daysUntilDue(dueOn: string | null, todayKey: string): number | null {
  if (!dueOn) return null;
  const due = Date.parse(`${dueOn.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${todayKey.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(due) || !Number.isFinite(today)) return null;
  return Math.round((due - today) / DAY);
}

/** The return state for a rent/borrow order. `dueSoonDays` sets the nudge window. */
export function returnStatus(
  order: { kind: string; status: string; endsOn: string | null; returnedAt?: string | null },
  todayKey: string,
  dueSoonDays = 2,
): ReturnStatus {
  if (order.kind !== 'rent' && order.kind !== 'borrow') return 'not_applicable';
  if (order.returnedAt || order.status === 'returned' || order.status === 'completed') return 'returned';
  if (order.status === 'cancelled') return 'not_applicable';
  const d = daysUntilDue(order.endsOn, todayKey);
  if (d === null) return 'not_applicable';
  if (d < 0) return 'overdue';
  if (d === 0) return 'due_today';
  if (d <= dueSoonDays) return 'due_soon';
  return 'upcoming';
}

export function isOverdue(order: { kind: string; status: string; endsOn: string | null; returnedAt?: string | null }, todayKey: string): boolean {
  return returnStatus(order, todayKey) === 'overdue';
}

/** Human label + tone for a return status (tone maps to UI color intent). */
export function returnLabel(status: ReturnStatus, dueOn: string | null, todayKey: string): { text: string; tone: 'muted' | 'info' | 'warn' | 'danger' | 'ok' } | null {
  const d = daysUntilDue(dueOn, todayKey);
  switch (status) {
    case 'returned':   return { text: 'Returned', tone: 'ok' };
    case 'upcoming':   return { text: d !== null ? `Due in ${d} day${d === 1 ? '' : 's'}` : 'Due later', tone: 'info' };
    case 'due_soon':   return { text: d !== null ? `Due in ${d} day${d === 1 ? '' : 's'}` : 'Due soon', tone: 'warn' };
    case 'due_today':  return { text: 'Due today', tone: 'warn' };
    case 'overdue':    return { text: d !== null ? `Overdue by ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'}` : 'Overdue', tone: 'danger' };
    default:           return null;
  }
}

/** Cron helper: does this order need a due-soon reminder now (not yet sent)? */
export function needsDueReminder(
  order: { kind: string; status: string; endsOn: string | null; dueReminderSentAt: string | null; returnedAt?: string | null },
  todayKey: string,
  dueSoonDays = 2,
): boolean {
  if (order.dueReminderSentAt) return false;
  const s = returnStatus(order, todayKey, dueSoonDays);
  return s === 'due_soon' || s === 'due_today';
}

/** Cron helper: does this order need an overdue alert now (not yet sent)? */
export function needsOverdueAlert(
  order: { kind: string; status: string; endsOn: string | null; overdueNotifiedAt: string | null; returnedAt?: string | null },
  todayKey: string,
): boolean {
  if (order.overdueNotifiedAt) return false;
  return returnStatus(order, todayKey) === 'overdue';
}
