import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dayKeyInZone, zonedTimeMs } from '@/lib/schedule/zoned';

// `lib/ai/context/slices/proactive.ts` built three day keys with
// `env.now.toISOString().slice(0, 10)` and then stapled `T00:00:00Z` /
// `T23:59:59Z` to them as bounds on TIMESTAMPTZ columns. Both halves were
// Greenwich, so they agreed with each other and with nothing the family lives
// in: "today" began at 09:00 in Tokyo, and at 16:00 the previous afternoon in
// Los Angeles. A school term starting on the family's Monday morning fell
// outside a window that had already moved on.
//
// The repair had to move FOUR things, not one, and that is the whole lesson of
// this file. Converting only the KEY would have been worse than leaving it
// alone — a family day key with a `Z` stapled to it is Greenwich midnight of
// the family's day, a third answer that is wrong in a new way. And the rows
// the reads return are reduced to day keys too (`startKey`, `createdKey`)
// before `detectLifeEvents` subtracts them from `todayKey`; leaving those at
// `String(x).slice(0, 10)` would have had it subtracting a Greenwich day from
// a family one.
const SLICE = 'lib/ai/context/slices/proactive.ts';
const raw = readFileSync(new URL(`../${SLICE}`, import.meta.url), 'utf8');

/**
 * COMMENTS ARE STRIPPED FIRST, and this repository learned that the hard way
 * rather than by good taste. When the Greenwich-day guard grew a third spelling,
 * the first file it flagged was the one whose comment EXPLAINED its own fix — so
 * deleting that comment would have "fixed" the file. A guard satisfiable by
 * removing a comment measures nothing. The same thing happened here within a
 * minute of writing these cases: the comment above quotes the exact
 * `T00:00:00Z` shape it exists to forbid.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const source = withoutComments(raw);

describe('the proactive slice asks for the family’s window, not Greenwich’s', () => {
  // What this can and cannot claim, stated rather than implied: the slice needs
  // a database and a context build, so these are SOURCE-SHAPE checks. They
  // cannot prove the read returns the right rows. They can prove that a named
  // guard has not been deleted, which is the regression that matters here,
  // because every previous instance of this defect was introduced by a later
  // edit rather than written wrong the first time.
  it('resolves today in the family zone rather than at Greenwich', () => {
    expect(source).toContain('dayKeyInZone(env.now.getTime(), zone)');
    // The fallback `?? env.now.toISOString().slice(0, 10)` is deliberate and
    // stays: dayKeyInZone returns null for an unparseable zone, and a Greenwich
    // key is a better answer there than none. What must never come back is
    // todayKey being ASSIGNED that slice outright, which is how it was written.
    expect(source, 'todayKey is being assigned the Greenwich slice again')
      .not.toMatch(/const\s+todayKey\s*=\s*env\.now\.toISOString\(\)/);
  });

  it('bounds the reads with real instants, not a day key with a Z stapled on', () => {
    // The exact shape that was wrong. If either comes back, the key and the
    // bound have stopped agreeing again.
    expect(source, 'a day key with a Z stapled to it is back as a bound').not.toContain('T00:00:00Z`');
    expect(source, 'a written-out end-of-day is back as a bound').not.toContain('T23:59:59Z`');
    expect(source).toContain("gte('starts_at', dayStartIso(todayKey))");
    expect(source).toContain("lte('starts_at', dayEndIso(termHorizon))");
    expect(source).toContain("gte('created_at', dayStartIso(petSince))");
  });

  it('reduces the returned rows to family day keys too, which is the half that gets forgotten', () => {
    expect(source).toContain('startKey: rowDayKey(e.starts_at)');
    expect(source).toContain('createdKey: rowDayKey(p.created_at)');
    expect(source, 'a timestamptz is being sliced at Greenwich again')
      .not.toMatch(/(?:starts_at|created_at)\)?\.slice\(0,\s*10\)/);
  });

  it('does its day arithmetic on the calendar, not on 86_400_000 from an instant', () => {
    expect(source).toContain('addDaysInZone(todayKey, SCHOOL_START_WINDOW_DAYS)');
    expect(source).toContain('addDaysInZone(todayKey, -8)');
    expect(source, 'a horizon is being built by adding milliseconds to env.now again')
      .not.toMatch(/env\.now\.getTime\(\)\s*[-+]\s*\w+\s*\*\s*86_400_000/);
  });

  // Non-vacuity floor. Four cases above are NEGATIVE — satisfied by a file that
  // stopped containing anything at all — so prove the file is being read and
  // that the matchers can still say no.
  it('and the file is really being read', () => {
    expect(source.length).toBeGreaterThan(2000);
    expect(source).toContain('export const proactiveSlice');
    expect(source).toMatch(/env\.now\.toISOString\(\)\s*\.slice\(0,\s*10\)/); // the documented fallback
    // And the stripper really strips: the file's own prose quotes the forbidden
    // shapes, so if it stopped working the negative cases above would fail
    // rather than pass, but a reader cannot see that from them.
    expect(raw, 'the source comment that quotes the forbidden bound has gone').toContain('T00:00:00Z`');
    expect(source, 'withoutComments is not removing block comments').not.toContain('stapled to it is');
  });
});

// The behaviour the slice's local helpers are composed from, tested for real
// rather than by reading. These are the two properties the repair depends on.
describe('the arithmetic those helpers are built out of', () => {
  const addDaysInZone = (key: string, n: number, zone: string) =>
    dayKeyInZone(zonedTimeMs(key, 12, 0, zone) + n * 86_400_000, zone);
  const dayEnd = (key: string, zone: string) =>
    zonedTimeMs(addDaysInZone(key, 1, zone)!, 0, 0, zone) - 1;

  it('adding calendar days survives a spring-forward, where +86_400_000 from midnight does not', () => {
    const zone = 'America/Los_Angeles';
    // 2026-03-08 is the US spring-forward: that local day is 23 hours long.
    expect(addDaysInZone('2026-03-07', 1, zone)).toBe('2026-03-08');
    expect(addDaysInZone('2026-03-08', 1, zone)).toBe('2026-03-09');
    // The counterexample, so the case above is not just restating a tautology:
    // adding a fixed 24h to local MIDNIGHT of the 8th lands back on the 8th,
    // because that day only has 23 hours in it.
    const midnight = zonedTimeMs('2026-03-08', 0, 0, zone);
    expect(dayKeyInZone(midnight + 86_400_000, zone)).toBe('2026-03-09');
    const fallBackMidnight = zonedTimeMs('2026-11-01', 0, 0, zone); // 25-hour day
    expect(dayKeyInZone(fallBackMidnight + 86_400_000, zone),
      'a 25-hour local day is exactly where the fixed-millisecond form lands short').toBe('2026-11-01');
    // And the noon-anchored form gets it right on that same day.
    expect(addDaysInZone('2026-11-01', 1, zone)).toBe('2026-11-02');
  });

  it('a day ends one millisecond before the next one starts, in every zone', () => {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Australia/Sydney']) {
      const end = dayEnd('2026-06-20', zone);
      const nextStart = zonedTimeMs('2026-06-21', 0, 0, zone);
      expect(end, zone).toBe(nextStart - 1);
      expect(dayKeyInZone(end, zone), zone).toBe('2026-06-20');
    }
  });

  it('and the family’s midnight is a different instant from Greenwich’s, which is the point', () => {
    const key = '2026-06-20';
    const greenwich = Date.parse(`${key}T00:00:00Z`);
    expect(zonedTimeMs(key, 0, 0, 'Asia/Tokyo')).toBe(greenwich - 9 * 3_600_000);
    expect(zonedTimeMs(key, 0, 0, 'America/Los_Angeles')).toBe(greenwich + 7 * 3_600_000);
    expect(zonedTimeMs(key, 0, 0, 'UTC')).toBe(greenwich);
  });
});
