import { describe, expect, it } from 'vitest';
import { startOfLocalDay, startOfNextLocalDay, localPartsAt } from '@/lib/time/zoned';

// F-017 / F-F02. `new Date(); d.setHours(0, 0, 0, 0)` is midnight where the
// PROCESS is running. In a browser that is the family; on a server it is
// whatever zone the host happens to be in, and on a UTC host a Californian
// family's "today" runs 17:00 to 17:00 — yesterday evening's events on today's
// list and this evening's missing from it.
//
// The suite pins TZ (see vitest.config.ts), so these cases are written to hold
// whatever the host is: each asserts the LOCAL READING in the target zone
// rather than a fixed UTC instant.

function readingIn(instant: Date, tz: string) {
  const p = localPartsAt(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

describe('the start of a family day', () => {
  it('is midnight where the family is, not where the server is', () => {
    // 05:00 UTC on 14 March: already the 14th in London and Tokyo, still
    // 22:00 on the 13th in Los Angeles. A host-zone boundary cannot tell those
    // apart — it answers with one day for all three families.
    const instant = new Date('2026-03-14T05:00:00Z');
    expect(readingIn(startOfLocalDay(instant, 'Europe/London'), 'Europe/London')).toBe('2026-03-14 00:00');
    expect(readingIn(startOfLocalDay(instant, 'America/Los_Angeles'), 'America/Los_Angeles')).toBe('2026-03-13 00:00');
    expect(readingIn(startOfLocalDay(instant, 'Asia/Tokyo'), 'Asia/Tokyo')).toBe('2026-03-14 00:00');
  });

  it('puts a late-evening moment on the family\'s own day, not the next one', () => {
    // 23:00 in Chicago is 05:00 the following day in UTC. A UTC host would put
    // this on tomorrow — the bug, exactly.
    const instant = new Date('2026-07-15T04:00:00Z'); // 23:00 on the 14th, Chicago
    expect(readingIn(instant, 'America/Chicago')).toBe('2026-07-14 23:00');
    expect(readingIn(startOfLocalDay(instant, 'America/Chicago'), 'America/Chicago')).toBe('2026-07-14 00:00');
  });

  it('brackets the day so every moment in it falls inside, and nothing else does', () => {
    const tz = 'America/Los_Angeles';
    const instant = new Date('2026-07-15T12:00:00Z');
    const start = startOfLocalDay(instant, tz);
    const end = startOfNextLocalDay(instant, tz);
    expect(start.getTime()).toBeLessThanOrEqual(instant.getTime());
    expect(end.getTime()).toBeGreaterThan(instant.getTime());
    expect(readingIn(end, tz)).toBe('2026-07-16 00:00');
    // One millisecond before the end is still today; the end itself is not.
    expect(localPartsAt(new Date(end.getTime() - 1), tz).day).toBe(15);
    expect(localPartsAt(end, tz).day).toBe(16);
  });
});

describe('the two days a fixed 24 hours gets wrong', () => {
  it('spring forward: the day is 23 hours, and the boundary still lands on midnight', () => {
    // 8 March 2026, America/Los_Angeles: 02:00 -> 03:00.
    const instant = new Date('2026-03-08T18:00:00Z'); // 10:00 local
    const tz = 'America/Los_Angeles';
    const start = startOfLocalDay(instant, tz);
    const end = startOfNextLocalDay(instant, tz);
    expect(readingIn(start, tz)).toBe('2026-03-08 00:00');
    expect(readingIn(end, tz)).toBe('2026-03-09 00:00');
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
    // Adding a fixed day would land at 01:00 on the 9th — an hour INTO the next
    // day, so the last hour of the 9th's morning is counted as the 8th's.
    expect(readingIn(new Date(start.getTime() + 24 * 60 * 60 * 1000), tz)).toBe('2026-03-09 01:00');
  });

  it('fall back: the day is 25 hours, and the boundary still lands on midnight', () => {
    // 1 November 2026, America/Los_Angeles: 02:00 -> 01:00.
    const instant = new Date('2026-11-01T18:00:00Z');
    const tz = 'America/Los_Angeles';
    const start = startOfLocalDay(instant, tz);
    const end = startOfNextLocalDay(instant, tz);
    expect(readingIn(start, tz)).toBe('2026-11-01 00:00');
    expect(readingIn(end, tz)).toBe('2026-11-02 00:00');
    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
    // A fixed day would end an hour SHORT — 23:00 on the 1st — so an 23:30
    // appointment falls outside the day it belongs to.
    expect(readingIn(new Date(start.getTime() + 24 * 60 * 60 * 1000), tz)).toBe('2026-11-01 23:00');
  });

  it('a zone whose clocks jump AT midnight still has a first moment', () => {
    // America/Santiago springs forward at 24:00, so 00:00 does not exist on
    // that date. Returning null would leave a day with no beginning; the first
    // minute that does exist is the answer.
    const instant = new Date('2026-09-06T15:00:00Z');
    const tz = 'America/Santiago';
    const start = startOfLocalDay(instant, tz);
    const p = localPartsAt(start, tz);
    expect(p.day).toBe(localPartsAt(instant, tz).day);
    expect(p.hour).toBeLessThanOrEqual(1);
    expect(start.getTime()).toBeLessThanOrEqual(instant.getTime());
  });
});

describe('an unusable zone is a correction that does not break the page', () => {
  it('falls back to the host midnight rather than throwing', () => {
    const instant = new Date('2026-07-15T12:00:00Z');
    const expected = new Date(instant);
    expected.setHours(0, 0, 0, 0);
    expect(startOfLocalDay(instant, 'Not/AZone').getTime()).toBe(expected.getTime());
    expect(startOfLocalDay(instant, '').getTime()).toBe(expected.getTime());
    expect(() => startOfNextLocalDay(instant, 'Not/AZone')).not.toThrow();
  });
});
