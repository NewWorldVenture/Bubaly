import { describe, expect, it } from 'vitest';
import { instantForIcsLocalTime, instantForLocalTime, zonedLocalToInstant, asWallClockUtc, asWallClockIn, dayKeyIn, startOfLocalDay, startOfNextLocalDay, daysInMonth } from '@/lib/time/zoned';
import { expandEventsInZone } from '@/lib/calendar/recurrence';
import { parseIcsDate } from '@/lib/sync/ics';
import { parseICSDate } from '@/lib/weekend/sources';
import { parseICS as parseMigrationIcs } from '@/lib/migrate/parse';

/**
 * A DST NIGHT READS AS RFC 5545 §3.3.5 SAYS.
 *
 * A calendar's DATE-TIME with a TZID names a wall-clock time. Twice a year the
 * wall clock is not a function of time: on the night the clocks go back an hour
 * happens twice, and on the night they go forward an hour never happens. RFC
 * 5545 §3.3.5 settles both: a time shown twice is its FIRST instant, and a time
 * skipped is read with the UTC offset in force BEFORE the gap.
 *
 * The ICS readers and the recurrence expander used `instantForLocalTime`, the
 * rule for an ad or a routine — walk a skipped time forward to the first minute
 * that exists — so a Chicago event published at 02:30 on 8 March 2026 landed at
 * 08:00Z (03:00 CDT) instead of 08:30Z, half an hour off every other reader of
 * the same feed; and the expander's choice in a fold depended on the zone's
 * side of Greenwich (New York got the first 01:30, London the second). Both now
 * go through one helper, `instantForIcsLocalTime`.
 */

const at = (y: number, mo: number, d: number, h: number, mi: number, tz: string) =>
  instantForIcsLocalTime(y, mo, d, h * 60 + mi, tz)?.toISOString();

describe('shared UTC construction preserves Gregorian years below100', () => {
  it.each([1, 4, 99, 100, 2026])('resolves explicit and routine clocks in year%i without century remapping', year => {
    const expected = `${String(year).padStart(4, '0')}-12-30T09:30:00.000Z`;
    expect(instantForIcsLocalTime(year, 12, 30, 570, 'UTC')?.toISOString()).toBe(expected);
    expect(zonedLocalToInstant(year, 12, 30, 570, 'UTC')?.toISOString()).toBe(expected);
    expect(instantForLocalTime(year, 12, 30, 570, 'UTC')?.toISOString()).toBe(expected);
  });
  it('preserves the wall-clock year and local day boundaries across0099→0100', () => {
    const instant = new Date('0099-12-31T12:34:00.000Z');
    expect(asWallClockUtc(instant, 'UTC').toISOString()).toBe('0099-12-31T12:34:00.000Z');
    expect(startOfLocalDay(instant, 'UTC').toISOString()).toBe('0099-12-31T00:00:00.000Z');
    expect(startOfNextLocalDay(instant, 'UTC').toISOString()).toBe('0100-01-01T00:00:00.000Z');
  });
  it('uses Gregorian leap rules for month lengths without mapping year0 to1900', () => {
    expect(daysInMonth(0, 2)).toBe(29);
    expect(daysInMonth(4, 2)).toBe(29);
    expect(daysInMonth(100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });
  it.each([99, 2026])('preserves runtime-local wall fields and padded family date keys in year%i', year => {
    const key = `${String(year).padStart(4, '0')}-12-30`;
    const instant = new Date(`${key}T09:30:00.000Z`);
    const wall = asWallClockIn(instant, 'UTC');
    expect([wall.getFullYear(), wall.getMonth(), wall.getDate(), wall.getHours(), wall.getMinutes()]).toEqual([year, 11, 30, 9, 30]);
    expect(dayKeyIn(instant, 'UTC')).toBe(key);
  });
});

describe('instantForIcsLocalTime', () => {
  it.each([
    ['Europe/London', 2026, 10, 25, 1, 30, '2026-10-25T00:30:00.000Z'],
    ['America/New_York', 2026, 11, 1, 1, 30, '2026-11-01T05:30:00.000Z'],
    ['Australia/Sydney', 2026, 4, 5, 2, 30, '2026-04-04T15:30:00.000Z'],
  ] as const)('a time %s shows twice is the first instant (%i-%i-%i %i:%i)', (tz, y, mo, d, h, mi, want) => {
    expect(at(y, mo, d, h, mi, tz)).toBe(want);
  });

  it.each([
    ['America/Chicago', 2026, 3, 8, 2, 30, '2026-03-08T08:30:00.000Z'],
    ['America/New_York', 2026, 3, 8, 2, 30, '2026-03-08T07:30:00.000Z'],
    ['Australia/Sydney', 2026, 10, 4, 2, 30, '2026-10-03T16:30:00.000Z'],
    ['Europe/London', 2026, 3, 29, 1, 30, '2026-03-29T01:30:00.000Z'],
    // Lord Howe moves by half an hour: 02:00 → 02:30, so 02:15 is skipped.
    ['Australia/Lord_Howe', 2026, 10, 4, 2, 15, '2026-10-03T15:45:00.000Z'],
  ] as const)('a time %s skips takes the offset in force before the gap (%i-%i-%i %i:%i)', (tz, y, mo, d, h, mi, want) => {
    expect(at(y, mo, d, h, mi, tz)).toBe(want);
  });

  it('is not the walk-forward rule, which stays what an ad or a routine uses', () => {
    expect(instantForLocalTime(2026, 3, 8, 150, 'America/Chicago')?.toISOString()).toBe('2026-03-08T08:00:00.000Z');
    expect(at(2026, 3, 8, 2, 30, 'America/Chicago')).toBe('2026-03-08T08:30:00.000Z');
  });

  it('reads an ordinary time, and the edges of a gap, as the clock shows them', () => {
    expect(at(2026, 6, 1, 9, 0, 'Asia/Tokyo')).toBe('2026-06-01T00:00:00.000Z');
    expect(at(2026, 3, 8, 1, 59, 'America/Chicago')).toBe('2026-03-08T07:59:00.000Z');
    expect(at(2026, 3, 8, 3, 0, 'America/Chicago')).toBe('2026-03-08T08:00:00.000Z');
    expect(at(2026, 11, 1, 2, 0, 'America/New_York')).toBe('2026-11-01T07:00:00.000Z');
    expect(at(2026, 7, 4, 12, 0, 'UTC')).toBe('2026-07-04T12:00:00.000Z');
  });
});

describe('every ICS reader reads a DST night the same way', () => {
  it('the calendar feed reader', () => {
    expect(parseIcsDate('20260308T023000', 'America/Chicago').iso).toBe('2026-03-08T08:30:00.000Z');
    expect(parseIcsDate('20261025T013000', 'Europe/London').iso).toBe('2026-10-25T00:30:00.000Z');
  });

  it('the weekend discovery reader', () => {
    expect(parseICSDate('20260308T023000', 'America/Chicago')).toBe('2026-03-08T08:30:00Z');
    expect(parseICSDate('20261025T013000', 'Europe/London')).toBe('2026-10-25T00:30:00Z');
  });

  it('the migration importer', () => {
    const one = (dt: string) => parseMigrationIcs([
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Night shift', `DTSTART;${dt}`, 'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n'))[0];
    expect(one('TZID=America/Chicago:20260308T023000').startsAt).toBe('2026-03-08T08:30:00.000Z');
    expect(one('TZID=Europe/London:20261025T013000').startsAt).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('the recurrence expander steps a series across a DST night by the same rule', () => {
  const weekly = (starts_at: string) => ({ id: 'series', starts_at, ends_at: null, recurrence: 'weekly', recurrence_until: null });

  it('a weekly 02:30 in Chicago is at 08:30Z on the night 02:30 is skipped', () => {
    const out = expandEventsInZone([weekly('2026-03-01T08:30:00.000Z')], new Date('2026-03-08T00:00:00Z'), new Date('2026-03-09T00:00:00Z'), 'America/Chicago');
    expect(out.map((o) => o.starts_at)).toEqual(['2026-03-08T08:30:00.000Z']);
  });

  it('a weekly 02:30 in Sydney is at 16:30Z on the 3rd when 4 October skips it', () => {
    const out = expandEventsInZone([weekly('2026-09-26T16:30:00.000Z')], new Date('2026-10-03T00:00:00Z'), new Date('2026-10-05T00:00:00Z'), 'Australia/Sydney');
    expect(out.map((o) => o.starts_at)).toEqual(['2026-10-03T16:30:00.000Z']);
  });

  it('a weekly 01:30 in London is the first 01:30 (BST) on the night it happens twice', () => {
    // 18 October 01:30 BST is 00:30Z; on the 25th 01:30 happens at 00:30Z (BST)
    // and again at 01:30Z (GMT). The expander used to take the second here.
    const out = expandEventsInZone([weekly('2026-10-18T00:30:00.000Z')], new Date('2026-10-25T00:00:00Z'), new Date('2026-10-26T00:00:00Z'), 'Europe/London');
    expect(out.map((o) => o.starts_at)).toEqual(['2026-10-25T00:30:00.000Z']);
  });

  it('a weekly 01:30 in New York is the first 01:30 (EDT) on the night it happens twice', () => {
    const out = expandEventsInZone([weekly('2026-10-25T05:30:00.000Z')], new Date('2026-11-01T00:00:00Z'), new Date('2026-11-02T00:00:00Z'), 'America/New_York');
    expect(out.map((o) => o.starts_at)).toEqual(['2026-11-01T05:30:00.000Z']);
  });
});
