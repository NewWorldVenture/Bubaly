import { describe, it, expect } from 'vitest';
import { dailyTotals, groupByMeal, todayKey, MEAL_META } from '@/lib/meals/tracker';

const log = (over: Partial<Parameters<typeof dailyTotals>[0][number]>) => ({
  member_id: 'm1', logged_on: '2025-06-01', meal: 'breakfast',
  calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, water_ml: 0, ...over,
});

describe('dailyTotals', () => {
  const logs = [
    log({ meal: 'breakfast', calories: 400, protein_g: 20, carbs_g: 40, fat_g: 10, water_ml: 250 }),
    log({ meal: 'lunch', calories: 600, protein_g: 30, carbs_g: 60, fat_g: 20, water_ml: 500 }),
    log({ member_id: 'm2', calories: 300 }),               // other member
    log({ logged_on: '2025-05-31', calories: 999 }),       // other day
  ];
  it('sums a day for one member', () => {
    const t = dailyTotals(logs, '2025-06-01', 'm1');
    expect(t).toEqual({ calories: 1000, protein_g: 50, carbs_g: 100, fat_g: 30, water_ml: 750, count: 2 });
  });
  it('sums a day for the whole family when no member given', () => {
    expect(dailyTotals(logs, '2025-06-01').calories).toBe(1300);
  });
});

describe('groupByMeal', () => {
  it('orders groups breakfast→lunch→dinner→snack', () => {
    const g = groupByMeal([{ meal: 'dinner' }, { meal: 'breakfast' }, { meal: 'snack' }]);
    expect(g.map((x) => x.meal)).toEqual(['breakfast', 'dinner', 'snack']);
  });
});

describe('todayKey / meta', () => {
  it('todayKey is YYYY-MM-DD', () => {
    expect(todayKey(new Date('2025-06-01T15:00:00Z'))).toBe('2025-06-01');
  });
  it('meal meta has labels', () => {
    expect(MEAL_META.breakfast.label).toBe('Breakfast');
  });
});
