// Partner-tone phrasing (T5). A calm, capable co-pilot never greets you with a
// red "24" — it tells you where you stand and what, if anything, wants a look.
// This is the single source of that voice: give it raw counts, get back a warm,
// specific line. Pure + DB-free so the phrasing is unit-tested in isolation and
// every surface (bell, notifications header, home hero) reads from one place.

/** `1 thing` / `3 things` — never a bare number leading a sentence. */
function count(n: number, singular: string, plural = singular + 's'): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * The notifications surface (bell tooltip + list header). Reassuring at zero,
 * gentle in the middle, offers help when the pile is genuinely big — never alarm.
 */
export function notificationsLine(unread: number): string {
  const n = Math.max(0, Math.floor(unread));
  if (n === 0) return "You're all caught up.";
  if (n === 1) return 'One thing wants a quick look.';
  if (n <= 5) return `You're in good shape — ${count(n, 'quick thing')} to glance at.`;
  if (n <= 15) return `${count(n, 'update')} waiting whenever you have a minute.`;
  return `A full inbox — ${n} to skim when you can. Want me to triage?`;
}

/** Accessible label for the bell icon. Short, spoken-friendly, still partner-toned. */
export function bellLabel(unread: number): string {
  const n = Math.max(0, Math.floor(unread));
  if (n === 0) return 'Notifications — all caught up';
  return `Notifications — ${count(n, 'update')} waiting`;
}

/** The signals the home hero can frame. All optional; missing = zero. */
export interface StatusCounts {
  approvals?: number;   // pending your OK (autopilot / concierge)
  overdue?: number;     // past-due reminders/chores
  dueToday?: number;    // on the plan for today
  conflicts?: number;   // schedule clashes needing a decision
  unread?: number;      // unread notifications
}

const clamp = (v: number | undefined) => Math.max(0, Math.floor(v ?? 0));

/**
 * The one-line "where you stand" the home hero shows in place of a wall of
 * badges. Partner voice surfaces the single most pressing thing (mirrors the
 * insight-of-the-day philosophy) and stays warm even when there's work to do.
 */
export function partnerStatus(input: StatusCounts): string {
  const approvals = clamp(input.approvals);
  const overdue = clamp(input.overdue);
  const conflicts = clamp(input.conflicts);
  const dueToday = clamp(input.dueToday);
  const unread = clamp(input.unread);

  if (overdue > 0) {
    return `A couple slipped past — ${count(overdue, 'item')} to close out, then you're clear.`;
  }
  if (conflicts > 0) {
    return `Heads up — ${count(conflicts, 'schedule clash', 'schedule clashes')} to sort when you get a sec.`;
  }
  if (approvals > 0) {
    return `You're in good shape — ${count(approvals, 'quick approval')} and tomorrow's set.`;
  }
  if (dueToday > 0) {
    return `${count(dueToday, 'thing')} on today's plan — nothing urgent, you've got this.`;
  }
  if (unread > 0) {
    return notificationsLine(unread);
  }
  return "Everything's handled. Go enjoy your day.";
}

/**
 * A compact badge label for cases where a number must still show (e.g. a tab),
 * capped so it never screams. Pairs with `notificationsLine` for the tooltip.
 */
export function badgeCount(n: number, cap = 9): string {
  const v = Math.max(0, Math.floor(n));
  return v > cap ? `${cap}+` : String(v);
}
