// The daily Autopilot pass reaches only as many families as its time budget
// allows. Where it starts decides who waits: each family must be reached within
// a bounded number of runs, whatever the per-run reach turns out to be.
import { describe, expect, it } from 'vitest';
import { rotateForRun, rotationOffset, vanDerCorput } from '@/lib/autopilot/cron-rotation';

/** Runs, from `firstRun`, until every one of `n` families has been in some run's first `c`. */
function runsToReachAll(n: number, c: number, firstRun: number): number {
  const seen = new Uint8Array(n);
  let left = n;
  let runs = 0;
  while (left > 0 && runs < 10 * n + 10) {
    const start = rotationOffset(n, firstRun + runs);
    for (let i = 0; i < Math.min(c, n); i++) {
      const f = (start + i) % n;
      if (!seen[f]) { seen[f] = 1; left--; }
    }
    runs++;
  }
  return runs;
}

describe('the Autopilot cron start rotation', () => {
  it.each([
    [5000, 500], [5000, 37], [4801, 333], [1000, 999], [400, 40], [60, 8], [7, 2], [2, 1], [1, 1],
  ])('reaches all %i families at %i a run within 4·N/C runs, from any day', (n, c) => {
    const bound = Math.ceil((4 * n) / c);
    for (let day = 20_700; day < 20_700 + 120; day += 11) {
      expect(runsToReachAll(n, c, day)).toBeLessThanOrEqual(bound);
    }
  });

  it("the reviewer's case: 5,000 families at 500 a run are all reached within 40 days, not ~4,500", () => {
    expect(runsToReachAll(5000, 500, Math.floor(Date.parse('2026-10-10T06:30:00Z') / 86_400_000))).toBeLessThanOrEqual(40);
  });

  it('is a rotation: every family once, in order from the start', () => {
    const ids = Array.from({ length: 13 }, (_, i) => i);
    for (let day = 0; day < 40; day++) {
      const order = rotateForRun(ids, day);
      expect([...order].sort((a, b) => a - b)).toEqual(ids);
      expect(order[0]).toBe(rotationOffset(ids.length, day));
    }
    expect(rotateForRun([], 5)).toEqual([]);
  });

  it('van der Corput stays in [0, 1)', () => {
    for (const i of [0, 1, 2, 3, 20_736, 2 ** 31, 2 ** 32 - 1]) {
      expect(vanDerCorput(i)).toBeGreaterThanOrEqual(0);
      expect(vanDerCorput(i)).toBeLessThan(1);
    }
    expect(vanDerCorput(1)).toBe(0.5);
  });
});
