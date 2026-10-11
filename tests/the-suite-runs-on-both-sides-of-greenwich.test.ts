import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { load } = createRequire(import.meta.url)('js-yaml') as {
  load(source: string): { jobs: Record<string, {
    env?: Record<string, string>;
    strategy?: { matrix?: { timezone?: string[] } };
    steps?: { run?: string; env?: Record<string, string> }[];
  }> };
};

// CI ran the unit suite twice, at TZ=UTC and at TZ=America/Los_Angeles. Both of
// those are AT or WEST of Greenwich, and that is a blind spot with a SIGN.
//
// A module that builds a Date from LOCAL parts and then reads the calendar day
// back out with `toISOString().slice(0, 10)` re-expresses that moment at
// Greenwich. West of Greenwich the day walks FORWARDS (local 20 June 23:30 in
// Los Angeles is already the 21st at Greenwich); east of it the day walks
// BACKWARDS (local 1 June 00:00 in Tokyo is still 31 May at Greenwich). One
// defect, two opposite symptoms, and the two zones CI ran could only ever see
// the forward one.
//
// A full run at TZ=Asia/Tokyo failed 15 tests across 8 files that were green in
// both CI runs — a budget period starting 31 May instead of 1 June, a
// marketplace return reported overdue on the day it was actually due, a trip
// exported to a family's calendar on the wrong days. None of that was new. It
// had simply never been looked at from the east.
//
// So this file is a RATCHET on the CI configuration itself rather than on any
// module: it asserts that the suite keeps being run from both sides. Deleting
// the step is allowed — but not silently, and not without deleting this too.
const CI = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

/** Every `TZ:` value the CI workflow binds a suite run to. */
function declaredZones(): string[] {
  const unit = load(CI).jobs.unit;
  if (unit?.env?.TZ !== '${{ matrix.timezone }}' || !unit.steps?.some((step) => step.run === 'npm test')) return [];
  return unit.strategy?.matrix?.timezone ?? [];
}

/**
 * Minutes that `zone` is ahead of UTC on a fixed midwinter instant. Read from
 * the platform's own tz database rather than written down, so this does not
 * silently rot when a government moves a zone.
 */
function offsetMinutes(zone: string): number {
  const at = new Date('2026-01-15T12:00:00Z');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUTC - at.getTime()) / 60_000);
}

describe('the unit suite is run from both sides of Greenwich', () => {
  it('declares at least one zone EAST of Greenwich', () => {
    const zones = declaredZones();
    const east = zones.filter((z) => offsetMinutes(z) > 0);
    expect(east.length,
      `ci.yml binds a suite run to [${zones.join(', ')}], none of them east of Greenwich. ` +
      'A day key taken with toISOString() walks backwards east of Greenwich and forwards ' +
      'west of it, so a west-only matrix can only ever see half of that defect.',
    ).toBeGreaterThan(0);
  });

  it('declares at least one zone WEST of Greenwich, which is the half that was already covered', () => {
    const zones = declaredZones();
    expect(zones.filter((z) => offsetMinutes(z) < 0).length,
      `ci.yml binds a suite run to [${zones.join(', ')}], none of them west of Greenwich.`,
    ).toBeGreaterThan(0);
  });

  // The step exists, is a real suite run, and is not pointed at something else.
  it('the eastern zone is bound to an actual `npm test` step', () => {
    const unit = load(CI).jobs.unit;
    expect(unit, 'the full-suite timezone matrix is gone from ci.yml').toBeDefined();
    expect(unit.steps?.filter((step) => step.run === 'npm test')).toHaveLength(1);
    expect(unit.env?.TZ).toBe('${{ matrix.timezone }}');
    expect(declaredZones().some((zone) => offsetMinutes(zone) > 0)).toBe(true);
  });

  // Non-vacuity floor. If the regexes above stopped matching anything, both
  // filters would return empty and the first two cases would fail loudly rather
  // than pass — but a reader cannot see that from the assertions themselves, so
  // it is stated: the parser found zones at all, and it found the ones we know
  // are there.
  it('and the parser is reading real values, not matching nothing', () => {
    const zones = declaredZones();
    expect(zones.length).toBeGreaterThanOrEqual(2);
    expect(zones).toContain('America/Los_Angeles');
    // A zone name the file does not contain must not be reported as present.
    expect(zones).not.toContain('Antarctica/Troll');
    // And the offset reader is not returning a constant.
    expect(offsetMinutes('Asia/Tokyo')).toBe(540);
    expect(offsetMinutes('America/Los_Angeles')).toBe(-480);
    expect(offsetMinutes('UTC')).toBe(0);
  });
});
