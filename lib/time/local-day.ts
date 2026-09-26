// lib/time/local-day.ts — the calendar day a moment falls on, where the reader is.
//
// `date.toISOString().slice(0, 10)` is the obvious way to get a YYYY-MM-DD and
// it is wrong for a calendar, because it answers in UTC. The failure is not
// subtle and it is not an edge case:
//
//   - A Date built from local parts — `d.setHours(0,0,0,0)` — is local midnight.
//     In Amsterdam (UTC+2) that instant is 22:00 UTC the PREVIOUS day, so its
//     `toISOString()` day is one behind. Every column of a week grid keyed that
//     way is labelled with the wrong date.
//   - An event's `starts_at` is a true instant, so ITS `toISOString()` day is
//     right. Mix the two and the grid and its contents disagree by one column.
//
// Replaying `calendar-module.tsx`'s own `weekStart`/`daysOfWeek` proved the
// consequence: in `Europe/Amsterdam` and `Asia/Tokyo` **none** of the seven days
// matched its own column, and the seventh day's events keyed to a day no column
// carried, so they were not rendered at all. In `America/New_York` events from
// 21:00 and in `America/Los_Angeles` events from 19:00 landed a column late.
// Six of the eleven locales this product ships are UTC+1 or UTC+2.
//
// So: for anything a person READS as a day, key both sides with this. Keep
// `toISOString()` for what it is good at — an instant to send to a server.
//
// This file is deliberately framework-free and safe in a client bundle: no
// `server-only`, no DOM, no Intl lookup. `lib/time/zoned.ts` is the other half
// of this problem — use `localPartsAt(instant, timezone)` there when the day
// must be the FAMILY's day rather than the reader's, which is what a server
// surface needs (see F-017).

/** `YYYY-MM-DD` for a Date, in the runtime's own timezone. */
export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `YYYY-MM-DD` for an ISO timestamp, or null when it is absent or unparseable. */
export function localDayKeyOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : localDayKey(d);
}

/** The local day `days` after (or before) the one `date` falls on. */
export function shiftLocalDay(date: Date, days: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return localDayKey(d);
}
