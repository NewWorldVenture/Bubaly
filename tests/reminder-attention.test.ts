import { describe, it, expect } from 'vitest';
import { reminderAttention } from '@/lib/dashboard/reminder-attention';
import { dayKeyInZone, zonedTimeMs } from '@/lib/schedule/zoned';

// `reminderAttention` splits on the day end ITS CALLER GIVES IT: `dueToday`
// means "still ahead of `now`, but before `dayEndExclusiveMs`".
//
// It used to derive that bound itself, with `setHours(23, 59, 59, 999)` on the
// caller's `now` — the end of the day in whatever zone the RUNTIME has. On
// Vercel that is UTC, and its caller components/dashboard/ai-home-dashboard.tsx
// had already resolved the FAMILY's day eleven lines earlier, with a comment
// saying so, before handing over a bare `now`. One function, two different
// "today". The last case in this file is the one that would have caught it.
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
  // The host's own next local midnight — what the module used to derive for
  // itself, now supplied, so the cases below still say what they said.
  const localDayEnd = new Date(2026, 5, 28, 0, 0, 0, 0).getTime();

  it('splits overdue vs due-later-today and ignores the rest', () => {
    const rows = [
      { remind_at: localJune(27, 9, 0), status: 'active' },      // earlier today → overdue
      { remind_at: localJune(27, 13, 59), status: 'active' },    // a minute ago → overdue
      { remind_at: localJune(27, 20, 0), status: 'active' },     // later today → dueToday
      { remind_at: localJune(28, 9, 0), status: 'active' },      // tomorrow → neither
      { remind_at: localJune(27, 10, 0), status: 'completed' },  // not active → ignored
      { remind_at: null, status: 'active' },                     // no time → ignored
    ];
    expect(reminderAttention(rows, now, localDayEnd)).toEqual({ overdue: 2, dueToday: 1 });
  });

  it('counts the end-of-day boundary as due today', () => {
    // Pin the exact edge: the LAST MILLISECOND of the local day is still today,
    // the first instant of the next local day is not. (The old literal stopped at
    // …:59.000, a whole second short of the bound, so it never actually tested
    // the boundary — an exclusive `<` bound would have passed it in every zone.)
    expect(reminderAttention([{ remind_at: localJune(27, 23, 59, 59, 999), status: 'active' }], now, localDayEnd))
      .toEqual({ overdue: 0, dueToday: 1 });
    expect(reminderAttention([{ remind_at: localJune(28, 0, 0, 0), status: 'active' }], now, localDayEnd))
      .toEqual({ overdue: 0, dueToday: 0 });
  });

  // THE CASE THAT WOULD HAVE CAUGHT THE DEFECT. The bound comes from a named
  // zone, and the instant under test sits between that zone's midnight and the
  // HOST's. A function that derives its own end-of-day from `now` answers with
  // the host's day and gets this wrong in one direction or the other on every
  // machine except one; a function that honours the bound it was given is right
  // everywhere. Both zones are named explicitly and neither is the host's, so
  // this asserts the contract rather than the machine.
  it.each([
    // Tokyo's day ends BEFORE Greenwich's, so a 22:00 JST reminder is still
    // today in Tokyo and already tomorrow by a UTC-derived bound.
    ['Asia/Tokyo', 22],
    // Los Angeles's day ends AFTER Greenwich's, so an 18:00 PDT reminder is
    // still today there and already past a UTC-derived bound.
    ['America/Los_Angeles', 18],
  ])('follows the day end it is handed, in %s', (zone, hour) => {
    const asked = new Date(zonedTimeMs('2026-06-27', 12, 0, zone));
    const todayKey = dayKeyInZone(asked.getTime(), zone)!;
    expect(todayKey, 'the fixture must be midday on the 27th in that zone').toBe('2026-06-27');
    const dayEnd = zonedTimeMs('2026-06-28', 0, 0, zone);
    const remindAt = new Date(zonedTimeMs('2026-06-27', hour, 0, zone)).toISOString();

    expect(reminderAttention([{ remind_at: remindAt, status: 'active' }], asked, dayEnd))
      .toEqual({ overdue: 0, dueToday: 1 });

    // Non-vacuity, and it is the heart of it: that same reminder falls OUTSIDE
    // a Greenwich-derived bound in at least one of the two zones, so the case
    // above is not simply restating something every bound would satisfy.
    const greenwichDayEnd = Date.parse('2026-06-28T00:00:00Z');
    const underGreenwich = reminderAttention(
      [{ remind_at: remindAt, status: 'active' }], asked, greenwichDayEnd);
    if (zone === 'Asia/Tokyo') {
      // 22:00 JST on the 27th is 13:00Z on the 27th — inside Greenwich's day
      // too, so here the two bounds agree and asserting a difference would be
      // asserting a falsehood. What differs is the OTHER end: Tokyo's day is
      // already over when Greenwich's still has nine hours to run.
      expect(underGreenwich).toEqual({ overdue: 0, dueToday: 1 });
      const tokyoTomorrow = new Date(zonedTimeMs('2026-06-28', 6, 0, zone)).toISOString();
      expect(reminderAttention([{ remind_at: tokyoTomorrow, status: 'active' }], asked, dayEnd),
        'tomorrow in Tokyo must not count as today').toEqual({ overdue: 0, dueToday: 0 });
      expect(reminderAttention([{ remind_at: tokyoTomorrow, status: 'active' }], asked, greenwichDayEnd),
        'but a Greenwich bound would have counted it').toEqual({ overdue: 0, dueToday: 1 });
    } else {
      // 18:00 PDT on the 27th is 01:00Z on the 28th — past Greenwich's
      // midnight, so a Greenwich-derived bound drops a reminder that is still
      // squarely today for the family.
      expect(underGreenwich,
        'a Greenwich bound loses a reminder that is still today in Los Angeles')
        .toEqual({ overdue: 0, dueToday: 0 });
    }
  });

  it('skips bad timestamps and returns zeros for an empty list', () => {
    expect(reminderAttention([{ remind_at: 'not-a-date', status: 'active' }], now, localDayEnd)).toEqual({ overdue: 0, dueToday: 0 });
    expect(reminderAttention([], now, localDayEnd)).toEqual({ overdue: 0, dueToday: 0 });
  });
});
