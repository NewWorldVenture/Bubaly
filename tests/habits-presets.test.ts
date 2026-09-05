import { describe, expect, it } from 'vitest';
import { HABIT_PRESETS, recommendedCupsPerDay, presetTarget, presetToHabit, presetByKey, dayProgress, doneDates, hydrationNudge } from '@/lib/habits/presets';

describe('hydration presets', () => {
  it('scale the water target by age', () => {
    expect(recommendedCupsPerDay(2)).toBe(4);
    expect(recommendedCupsPerDay(6)).toBe(5);
    expect(recommendedCupsPerDay(11)).toBe(7);
    expect(recommendedCupsPerDay(15)).toBe(9);
    expect(recommendedCupsPerDay(40)).toBe(8);
    expect(recommendedCupsPerDay(null)).toBe(8);
  });
  it('have unique keys and turn into habit rows', () => {
    expect(new Set(HABIT_PRESETS.map((p) => p.key)).size).toBe(HABIT_PRESETS.length);
    const water = presetByKey('water-cups')!;
    expect(presetTarget(water, 6)).toBe(5);
    const row = presetToHabit(water, { id: 'm1', age: 6 });
    expect(row).toMatchObject({ title: '💧 Drink water', cadence: 'daily', target_per_period: 5, member_id: 'm1', weekdays: [] });
    expect(row.description).toContain('Target: 5 cups a day');
    expect(presetToHabit(presetByKey('bottle-refills')!, { id: null, age: null }).target_per_period).toBe(3);
    expect(presetByKey('nope')).toBeNull();
  });
});

describe('count logging', () => {
  const logs = [
    { habit_id: 'h', log_date: '2026-09-05', count: 3 }, { habit_id: 'h', log_date: '2026-09-05', count: 2 },
    { habit_id: 'h', log_date: '2026-09-04', count: 8 }, { habit_id: 'h', log_date: '2026-09-03', count: 1 }, { habit_id: 'x', log_date: '2026-09-05', count: 9 },
  ];
  it('sums the day and only counts full days for streaks', () => {
    expect(dayProgress(logs, 'h', '2026-09-05', 8)).toEqual({ count: 5, target: 8, pct: 63, done: false });
    expect(doneDates(logs, 'h', 8)).toEqual(['2026-09-04']);
    expect(doneDates(logs, 'h', 1).sort()).toEqual(['2026-09-03', '2026-09-04', '2026-09-05']);
  });
  it('nudges when behind the day’s pace', () => {
    expect(hydrationNudge({ count: 1, target: 8 }, 16)).toBe('4 behind pace for this time of day'); // 9 of 15 hours → 5 expected
    expect(hydrationNudge({ count: 5, target: 8 }, 16)).toBeNull();
    expect(hydrationNudge({ count: 8, target: 8 }, 20)).toBe('Target met — nice.');
    expect(hydrationNudge({ count: 0, target: 1 }, 20)).toBeNull();
  });
});
