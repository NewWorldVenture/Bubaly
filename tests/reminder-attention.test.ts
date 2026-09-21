import { describe, it, expect } from 'vitest';
import { reminderAttention } from '@/lib/dashboard/reminder-attention';

// `reminderAttention` splits on the READER'S LOCAL DAY: `dueToday` means "still
// ahead of `now`, but before local midnight tonight" (the module bounds it with
// `setHours(23, 59, 59, 999)` on the caller's `now`).
//
// The old fixtures hard-coded UTC instants — '2026-06-27T20:00:00.000Z' labelled
// "later today" and '2026-06-27T23:59:59.000Z' labelled "the end-of-day boundary"
// — against a `now` of '2026-06-27T14:00:00.000Z'. Those labels only hold on a
// host between roughly UTC-14 and UTC+04. In Asia/Tokyo `now` is 23:00 on the
// 27th and those two instants are 05:00 and 08:59 on the 28th: genuinely
// tomorrow, so `dueToday: 0` was the right answer and the literals were
// asserting the host's UTC offset rather than the contract.
//
// Fixtures are therefore built from LOCAL calendar parts, so "earlier today",
// "later today" and "tomorrow" land in the intended local day in every zone.
// (`.toISOString()` here only serializes an instant for the row's string field;
// no calendar day is ever read back out of it.)

/** An instant at the given LOCAL wall-clock time on `day` June 2026. */
const localJune = (day: number, h: number, m = 0, s = 0, ms = 0) =>
  new Date(2026, 5, day, h, m, s, ms).toISOString();

describe('reminderAttention', () => {
  // Local 14:00 on 27 June 2026 — mid-afternoon wherever the test runs, so
  // "earlier today" and "later today" both exist in the host's local day.
  const now = new Date(2026, 5, 27, 14, 0, 0, 0);

  it('splits overdue vs due-later-today and ignores the rest', () => {
    const rows = [
      { remind_at: localJune(27, 9, 0), status: 'active' },      // earlier today → overdue
      { remind_at: localJune(27, 13, 59), status: 'active' },    // a minute ago → overdue
      { remind_at: localJune(27, 20, 0), status: 'active' },     // later today → dueToday
      { remind_at: localJune(28, 9, 0), status: 'active' },      // tomorrow → neither
      { remind_at: localJune(27, 10, 0), status: 'completed' },  // not active → ignored
      { remind_at: null, status: 'active' },                     // no time → ignored
    ];
    expect(reminderAttention(rows, now)).toEqual({ overdue: 2, dueToday: 1 });
  });

  it('counts the end-of-day boundary as due today', () => {
    // Pin the exact edge: the LAST MILLISECOND of the local day is still today,
    // the first instant of the next local day is not. (The old literal stopped at
    // …:59.000, a whole second short of the bound, so it never actually tested
    // the boundary — an exclusive `<` bound would have passed it in every zone.)
    expect(reminderAttention([{ remind_at: localJune(27, 23, 59, 59, 999), status: 'active' }], now))
      .toEqual({ overdue: 0, dueToday: 1 });
    expect(reminderAttention([{ remind_at: localJune(28, 0, 0, 0), status: 'active' }], now))
      .toEqual({ overdue: 0, dueToday: 0 });
  });

  it('skips bad timestamps and returns zeros for an empty list', () => {
    expect(reminderAttention([{ remind_at: 'not-a-date', status: 'active' }], now)).toEqual({ overdue: 0, dueToday: 0 });
    expect(reminderAttention([], now)).toEqual({ overdue: 0, dueToday: 0 });
  });
});
