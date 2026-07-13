// Marketplace rent/borrow returns — pure engine, no I/O.
//
// Turns an order's due date (ends_on) into a return status the Orders page and
// the return-reminders cron both read. Fully tested; the cron's dedupe stamps
// live in the DB, this only computes the human-facing state.

export type ReturnStatus = 'not_applicable' | 'returned' | 'upcoming' | 'due_soon' | 'due_today' | 'overdue';

const DAY = 86400_000;

/** Midnight-aligned whole-day difference (dueOn - today), in days. */
export function daysUntilDue(dueOn: string | null, now: Date = new Date()): number | null {
  if (!dueOn) return null;
  const due = new Date(dueOn + 'T00:00:00');
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / DAY);
}

/** The return state for a rent/borrow order. `dueSoonDays` sets the nudge window. */
export function returnStatus(
  order: { kind: string; status: string; endsOn: string | null; returnedAt?: string | null },
  now: Date = new Date(),
  dueSoonDays = 2,
): ReturnStatus {
  if (order.kind !== 'rent' && order.kind !== 'borrow') return 'not_applicable';
  if (order.returnedAt || order.status === 'returned' || order.status === 'completed') return 'returned';
  if (order.status === 'cancelled') return 'not_applicable';
  const d = daysUntilDue(order.endsOn, now);
  if (d === null) return 'not_applicable';
  if (d < 0) return 'overdue';
  if (d === 0) return 'due_today';
  if (d <= dueSoonDays) return 'due_soon';
  return 'upcoming';
}

export function isOverdue(order: { kind: string; status: string; endsOn: string | null; returnedAt?: string | null }, now: Date = new Date()): boolean {
  return returnStatus(order, now) === 'overdue';
}

/** Human label + tone for a return status (tone maps to UI color intent). */
export function returnLabel(status: ReturnStatus, dueOn: string | null = null, now: Date = new Date()): { text: string; tone: 'muted' | 'info' | 'warn' | 'danger' | 'ok' } | null {
  const d = daysUntilDue(dueOn, now);
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
  now: Date = new Date(),
  dueSoonDays = 2,
): boolean {
  if (order.dueReminderSentAt) return false;
  const s = returnStatus(order, now, dueSoonDays);
  return s === 'due_soon' || s === 'due_today';
}

/** Cron helper: does this order need an overdue alert now (not yet sent)? */
export function needsOverdueAlert(
  order: { kind: string; status: string; endsOn: string | null; overdueNotifiedAt: string | null; returnedAt?: string | null },
  now: Date = new Date(),
): boolean {
  if (order.overdueNotifiedAt) return false;
  return returnStatus(order, now) === 'overdue';
}
