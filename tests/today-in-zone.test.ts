import { describe, expect, it } from 'vitest';
import { todayInZone } from '@/lib/schedule/zoned';

// `new Date().toISOString().slice(0, 10)` answers the day at Greenwich. For a
// family west of UTC that is tomorrow for the last hours of their evening; for
// a family east of it, yesterday for the first hours of their morning. Written
// into a DATE column the difference persists.
describe('todayInZone', () => {
  // 01:30 UTC — still the previous day everywhere in the Americas.
  const earlyUtc = Date.UTC(2026, 8, 18, 1, 30);
  // 23:30 UTC — already tomorrow everywhere east of the prime meridian.
  const lateUtc = Date.UTC(2026, 8, 18, 23, 30);

  it('gives the day on the family wall, not the day at Greenwich', () => {
    expect(new Date(earlyUtc).toISOString().slice(0, 10)).toBe('2026-09-18');
    expect(todayInZone('America/Los_Angeles', earlyUtc)).toBe('2026-09-17');
    expect(todayInZone('America/New_York', earlyUtc)).toBe('2026-09-17');
    expect(todayInZone('UTC', earlyUtc)).toBe('2026-09-18');

    expect(new Date(lateUtc).toISOString().slice(0, 10)).toBe('2026-09-18');
    expect(todayInZone('Pacific/Auckland', lateUtc)).toBe('2026-09-19');
    expect(todayInZone('Asia/Tokyo', lateUtc)).toBe('2026-09-19');
    expect(todayInZone('America/Los_Angeles', lateUtc)).toBe('2026-09-18');
  });

  it('is the shape a DATE column takes', () => {
    expect(todayInZone('Australia/Sydney', earlyUtc)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back to the Greenwich day rather than throwing on an unusable zone', () => {
    // A bad zone must not take down a form that is only asking for today.
    expect(todayInZone('Not/AZone', earlyUtc)).toBe('2026-09-18');
    expect(todayInZone('', earlyUtc)).toBe('2026-09-18');
  });

  it('reads the clock when no instant is given', () => {
    expect(todayInZone('UTC')).toBe(new Date().toISOString().slice(0, 10));
  });

  it('resolves the DST fall-back day, where a wall clock repeats an hour', () => {
    // 2026-11-01 05:30Z and 06:30Z are both 01:30 local in New York. Both are
    // still the 1st — the repeated hour must not roll the day.
    expect(todayInZone('America/New_York', Date.UTC(2026, 10, 1, 5, 30))).toBe('2026-11-01');
    expect(todayInZone('America/New_York', Date.UTC(2026, 10, 1, 6, 30))).toBe('2026-11-01');
  });
});
