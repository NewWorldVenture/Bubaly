// A server component renders in the SERVER's timezone, and the server is not in
// the family's kitchen.
//
// `app/(app)/home/page.tsx` is the case that made this concrete. It resolves the
// family's zone and uses it to decide which events are today:
//
//     const tz = ctx.active.family.timezone || 'UTC';
//     const todayKey = dayKeyInTz(now, tz);
//     const dayBounds = zonedDayBoundsMs(todayKey, tz);
//
// and then printed each one's clock with a formatter bound to no zone at all, so
// `Intl.DateTimeFormat` used the runtime's — UTC on Vercel. The right events, at
// the wrong times. Measured before the fix, at the formatter, for a task due
// 09:00 Monday for a family in Los Angeles, asked at 18:30 on Sunday their time:
//
//     TZ=UTC                  "Today, 4:00 PM"
//     TZ=America/Los_Angeles  "Tomorrow, 9:00 AM"
//
// Wrong day and wrong clock, in the direction where a family misses the thing.
//
// This is the same arithmetic `tests/family-day-not-greenwich-day.test.ts`
// measures for DATE COLUMNS, reaching the reader through a different door: that
// guard scans for `toISOString().slice(0, 10)`, and nothing it looks for appears
// anywhere near `isToday` or `Intl.DateTimeFormat`.
//
// The clock is pinned throughout. A test about which calendar day an instant
// falls on cannot also be reading the wall clock — see TIME-001, where exactly
// that combination was right 23 hours out of 24 and went red in CI at 23:04.
//
// AND IT MUST NOT ASSUME THE HOST'S ZONE EITHER, which is the half this file got
// wrong on its first run. Every counterexample below used to read
// `createFormat('en-US')` — no zone — and assert it produced the WRONG answer.
// That is only true where the runtime is UTC. CI runs the whole suite a second
// time with `TZ: America/Los_Angeles` (ci.yml, "Unit tests (DST-observing
// host)"), and America/Los_Angeles is the very zone used as the family's here,
// so on that host the bound and unbound formatters agreed and four cases failed:
//
//     expected 'Tomorrow, 9:00 AM' to be 'Today, 4:00 PM'
//     expected '9:00 AM' not to be '9:00 AM'
//
// Pinning the clock and then hard-coding the zone is TIME-001 again, committed
// in the test written to fix TIME-001's class. So the comparisons below name TWO
// EXPLICIT ZONES and never compare against "unbound"; the one property that is
// genuinely about the runtime is asserted against the runtime's own resolved
// zone, which is true on every host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormat } from '@/lib/utils/format';

const LA = 'America/Los_Angeles';

// 18:30 Sunday 20 September in Los Angeles is already 01:30 Monday in UTC.
const ASKED_AT = new Date('2026-09-21T01:30:00Z');
// A task due 09:00 on Monday, their time.
const DUE = new Date('2026-09-21T16:00:00Z');

describe('a server-rendered time is the family’s time', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ASKED_AT);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says Tomorrow 9:00 AM for a task due 09:00 tomorrow in the family’s zone', () => {
    expect(createFormat('en-US', undefined, LA).fmtRelative(DUE)).toBe('Tomorrow, 9:00 AM');
  });

  // The counterexample, kept as an assertion rather than a comment. Without a
  // zone the formatter answers in the runtime's, and the suite pins TZ=UTC, so
  // this IS what the page rendered before the fix. If this line ever starts
  // agreeing with the one above, the two are no longer being told apart and the
  // case above has stopped proving anything.
  it('and in Greenwich the same instant is Today 4:00 PM, which is what the page showed', () => {
    const atGreenwich = createFormat('en-US', undefined, 'UTC').fmtRelative(DUE);
    expect(atGreenwich).toBe('Today, 4:00 PM');
    expect(atGreenwich).not.toBe(createFormat('en-US', undefined, LA).fmtRelative(DUE));
  });

  it('prints the clock in the family’s zone, not the runtime’s', () => {
    expect(createFormat('en-US', undefined, LA).fmtTime(DUE)).toBe('9:00 AM');
    expect(createFormat('en-US', undefined, 'UTC').fmtTime(DUE)).toBe('4:00 PM');
  });

  it('puts a late-evening instant on the family’s date, not Greenwich’s', () => {
    // 21:00 Sunday in Los Angeles — already Monday at Greenwich.
    const lateSunday = new Date('2026-09-21T04:00:00Z');
    expect(createFormat('en-US', undefined, LA).fmtDate(lateSunday)).toContain('Sun');
    expect(createFormat('en-US', undefined, 'UTC').fmtDate(lateSunday)).toContain('Mon');
  });

  // Tomorrow is the day AFTER today, and twice a year that is not 24 hours away.
  // Advancing the day KEY rather than the instant is what makes these hold; a
  // `now + 86_400_000` implementation lands on the same date in a 25-hour day and
  // skips one in a 23-hour day.
  describe('across a DST transition, tomorrow is still tomorrow', () => {
    const NY = 'America/New_York';
    // Both rows are chosen so that a `now + 86_400_000` implementation gets a
    // DIFFERENT answer, which is what makes them tests rather than decoration.
    it.each([
      // 23:30 on Saturday 7 March, the evening before New York springs forward.
      // Tomorrow is the 8th. Adding 24 real hours lands at 00:30 on the 9th,
      // because the 8th is only 23 hours long — it SKIPS the day.
      ['the day before the 23-hour day', '2026-03-08T04:30:00Z', '2026-03-08T13:00:00Z'],
      // 00:30 on Sunday 1 November, inside the 25-hour day. Tomorrow is the 2nd.
      // Adding 24 real hours lands at 23:30 on the 1st — still TODAY, so a +24h
      // implementation would have today and tomorrow be the same date.
      ['inside the 25-hour day', '2026-11-01T04:30:00Z', '2026-11-02T14:00:00Z'],
    ])('%s', (_label, nowIso, tomorrowIso) => {
      vi.setSystemTime(new Date(nowIso));
      expect(createFormat('en-US', undefined, NY).fmtRelative(new Date(tomorrowIso)))
        .toMatch(/^Tomorrow, /);
    });
  });

  // The trap inside the fix, and the reason "bind the zone everywhere" is wrong.
  //
  // A TIMESTAMP names an instant and must be converted. A DATE column is already
  // the day on the family's wall and has none, so converting it MOVES it: bound
  // to Los Angeles, `parseISO('2026-09-21')` is local midnight, which is 17:00 on
  // the 20th there, and a bill due the 21st renders "Sun, Sep 20".
  //
  // That is not hypothetical — `app/(app)/dashboard/family-cfo/page.tsx` formats
  // `b.due_date`, and binding its formatter was going to be part of this commit.
  // Failing to convert a timestamp and converting a date are the same error, one
  // day apart in opposite directions.
  describe('a DATE column is the family’s day already, so it is not converted', () => {
    const DUE_DATE = '2026-09-21';
    it.each(['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Etc/GMT+12'])(
      'renders the same day in %s as it does unbound', (tz) => {
        expect(createFormat('en-US', undefined, tz).fmtDate(DUE_DATE))
          .toBe(createFormat('en-US').fmtDate(DUE_DATE));
      });

    it('says the day it says, whatever the zone', () => {
      expect(createFormat('en-US', undefined, 'America/Los_Angeles').fmtDate(DUE_DATE))
        .toBe('Mon, Sep 21');
    });

    // And the relative label takes the same path: a date's own text IS its day
    // key, so it is compared as written rather than converted.
    it('calls a DATE of today Today, from a zone where the instant would not be', () => {
      // 23:30 on the 20th in Los Angeles — already the 21st at Greenwich.
      vi.setSystemTime(new Date('2026-09-21T06:30:00Z'));
      expect(createFormat('en-US', undefined, 'America/Los_Angeles').fmtRelative('2026-09-20'))
        .toMatch(/^Today, /);
    });
  });

  // The 144 files that still import the bare `fmtDate`/`fmtTime` exports get the
  // runtime's zone, exactly as they did before this parameter existed. That is
  // correct in a browser, where the runtime IS the reader, and it is the reason
  // the zone is opt-in rather than required.
  it('leaves the unbound formatter exactly as it was: the runtime’s own zone', () => {
    const f = createFormat('en-US');
    // Stated against the RUNTIME's resolved zone rather than against a literal,
    // because "what it was" IS the runtime zone and that differs per host — which
    // is the whole lesson in the header. This holds under TZ=UTC and under
    // TZ=America/Los_Angeles alike.
    const runtime = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const asRuntime = createFormat('en-US', undefined, runtime);
    for (const value of ['2026-07-14T14:30:00Z', '2026-01-02T23:45:00Z', DUE.toISOString()]) {
      expect(f.fmtTime(value), value).toBe(asRuntime.fmtTime(value));
      expect(f.fmtDate(value), value).toBe(asRuntime.fmtDate(value));
      expect(f.fmtDateTime(value), value).toBe(asRuntime.fmtDateTime(value));
    }
    // A local-wall-clock string and money carry no zone at all, so these are
    // literals on any host.
    expect(f.fmtTime('2026-07-14T09:05:00')).toBe('9:05 AM');
    expect(f.fmtMoney(1250)).toBe('$12.50');
  });

  // A bad IANA string reaches this from a `families.timezone` column, and a
  // household page is not the place to throw over one. It degrades to the
  // pre-zone behaviour, which is the same answer the page gave yesterday.
  it('falls back rather than throwing on a timezone the column should not hold', () => {
    const f = createFormat('en-US', undefined, 'Mars/Olympus_Mons');
    expect(() => f.fmtTime(DUE)).not.toThrow();
    expect(f.fmtTime(DUE)).toBe(createFormat('en-US').fmtTime(DUE));
  });

  // Non-vacuity floor. Every case above compares a zoned answer against an
  // unzoned one, and all of them would pass trivially if `timeZone` were
  // silently ignored and both sides collapsed to the same string. This asserts
  // the two are actually different for the same instant, so the comparisons
  // above are comparisons.
  it('the zone changes the answer at all, or nothing above is a test', () => {
    const zoned = createFormat('en-US', undefined, LA);
    const plain = createFormat('en-US', undefined, 'UTC');
    const differ = [
      [zoned.fmtTime(DUE), plain.fmtTime(DUE)],
      [zoned.fmtRelative(DUE), plain.fmtRelative(DUE)],
      [zoned.fmtDate(new Date('2026-09-21T04:00:00Z')), plain.fmtDate(new Date('2026-09-21T04:00:00Z'))],
    ];
    for (const [a, b] of differ) expect(a).not.toBe(b);
    expect(differ.length).toBeGreaterThan(0);
  });
});
