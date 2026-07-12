// lib/calendar/recurrence.ts — pure, unit-tested recurring-event expansion.
//
// calendar_events stores a recurrence rule ('none'|'daily'|'weekly'|'monthly'|
// 'yearly' + optional recurrence_until), but until this module NOTHING expanded
// it: a weekly event rendered once on its start date and vanished from every
// later week. This expands recurring events into concrete occurrences inside a
// view window, client-side and DB-free, so any view (month/week/day/agenda) can
// treat the result as plain events. Occurrences keep the source row's id (so the
// detail modal/RSVPs work) with shifted starts_at/ends_at; render keys should
// therefore combine id + starts_at.

export interface RecurrableEvent {
  id: string;
  starts_at: string;
  ends_at: string | null;
  recurrence: string;
  recurrence_until?: string | null;
}

/** Hard cap on generated occurrences per event (a daily event over a 6-week
 *  month grid is ~42; 500 protects against pathological windows). */
const MAX_OCCURRENCES = 500;

/** The n-th occurrence, computed FROM THE BASE date every time — a mutating
 *  cursor would drift permanently after a month rolls (Jan 31 +1mo → Mar 3,
 *  then every later step runs from the 3rd instead of the 31st). */
function occurrenceAt(base: Date, freq: string, n: number): Date | null {
  const d = new Date(base);
  switch (freq) {
    case 'daily': d.setDate(d.getDate() + n); break;
    case 'weekly': d.setDate(d.getDate() + n * 7); break;
    case 'monthly': d.setMonth(d.getMonth() + n); break;
    case 'yearly': d.setFullYear(d.getFullYear() + n); break;
    default: return null;
  }
  return d;
}

/** True when a month/year step rolled the day-of-month (e.g. Jan 31 → Mar 3);
 *  such occurrences are skipped so "the 31st monthly" doesn't drift. */
function dayRolled(base: Date, candidate: Date, freq: string): boolean {
  return (freq === 'monthly' || freq === 'yearly') && candidate.getDate() !== base.getDate();
}

/**
 * Expand `events` into the concrete occurrences that fall inside
 * [windowStart, windowEnd). Non-recurring events pass through untouched when
 * in-window; recurring events yield one clone per occurrence (same id, shifted
 * starts_at/ends_at). `recurrence_until`, when set, ends the series.
 */
export function expandEvents<T extends RecurrableEvent>(
  events: T[],
  windowStart: Date,
  windowEnd: Date,
): T[] {
  const out: T[] = [];
  for (const e of events) {
    const start = new Date(e.starts_at);
    if (Number.isNaN(start.getTime())) continue;

    if (!e.recurrence || e.recurrence === 'none') {
      if (start >= windowStart && start < windowEnd) out.push(e);
      continue;
    }

    const until = e.recurrence_until ? new Date(e.recurrence_until) : null;
    const seriesEnd = until && until < windowEnd ? until : windowEnd;
    const durationMs = e.ends_at ? new Date(e.ends_at).getTime() - start.getTime() : null;

    for (let n = 0; n < MAX_OCCURRENCES; n++) {
      const cursor = occurrenceAt(start, e.recurrence, n);
      if (!cursor) break;                 // unknown freq value
      if (cursor >= seriesEnd) break;     // occurrenceAt is monotone in n
      if (cursor >= windowStart && !dayRolled(start, cursor, e.recurrence)) {
        out.push({
          ...e,
          starts_at: cursor.toISOString(),
          ends_at: durationMs !== null ? new Date(cursor.getTime() + durationMs).toISOString() : null,
        });
      }
    }
  }
  out.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return out;
}
