import { parseISO } from 'date-fns';

// A `date` column ('2026-03-01') names a day on the family's calendar, not an
// instant. `new Date('2026-03-01')` is UTC midnight, which everywhere west of
// Greenwich is the evening of the day before, so a local getMonth()/getDate()
// on it answers for the wrong day: on a US device a transaction dated the 1st
// counted toward the previous month's spending, and a bill due on the 1st sat
// on the last day of the month before in the bills calendar. parseISO reads a
// date-only string as local midnight on that day, so local getters are right.

/** A date-only string as local midnight on that day, or null if missing or unparseable. */
export function parseCalendarDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = parseISO(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whether a date-only string falls in the given local year and month (0-based). */
export function isInMonth(value: string | null | undefined, year: number, month: number): boolean {
  const d = parseCalendarDate(value);
  return d !== null && d.getFullYear() === year && d.getMonth() === month;
}

/** Local midnight at the start of `now`'s day. */
export function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
