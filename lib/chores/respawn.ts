// lib/chores/respawn.ts — when a recurring chore's next assignment is due.
// Pure and clock-free (the caller passes `now`), so the board and the server
// agree on the answer and a test can pin it.
import { nextRemindAt } from '@/lib/reminders/details';

/** True for a chore that repeats: any cadence but 'none'. */
export function choreRepeats(recurrence: string | null | undefined): boolean {
  return !!recurrence && recurrence !== 'none';
}

/**
 * When the next assignment of a recurring chore is due, once one of its
 * assignments is approved at `nowIso`.
 *
 * Stepped from the approved assignment's own due time — a daily chore due at
 * 18:00 is next due at 18:00 tomorrow — until it is strictly after now, so a
 * chore approved three days late is next due tomorrow, not on three dates
 * already past. An assignment with no due time steps from now. Null when the
 * chore does not repeat, its cadence is one nothing can step, or `nowIso`
 * cannot be read.
 */
export function nextChoreDueAt(dueAt: string | null | undefined, recurrence: string | null | undefined, nowIso: string): string | null {
  if (!choreRepeats(recurrence)) return null;
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) return null;
  let cursor = dueAt && !Number.isNaN(Date.parse(dueAt)) ? dueAt : nowIso;
  // A daily chore whose assignment went stale walks a step a day; the cap is
  // well past a decade of neglect.
  for (let step = 0; step < 5000; step += 1) {
    const next = nextRemindAt(cursor, recurrence as string);
    if (!next) return null;
    if (Date.parse(next) > now) return next;
    cursor = next;
  }
  return null;
}
