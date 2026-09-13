import { describe, expect, it } from 'vitest';
import { formatMealDay, mealWeek, mealWeekDays } from '@/lib/meals/week';
import { weekDates } from '@/lib/meals/planner';

describe('household meal calendar', () => {
  it('uses the household Monday when the same instant is still Sunday elsewhere', () => {
    const now = new Date('2026-09-13T12:30:00Z');
    expect(mealWeek('Pacific/Kiritimati', 0, now)).toEqual({
      start: '2026-09-14', today: '2026-09-14',
      days: ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'],
    });
    expect(mealWeek('America/Los_Angeles', 0, now).start).toBe('2026-09-07');
    expect(mealWeek('America/Los_Angeles', 0, now).today).toBe('2026-09-13');
  });

  it.each(['2026-03-08T06:59:00Z', '2026-03-08T07:01:00Z', '2026-11-01T05:59:00Z', '2026-11-01T06:01:00Z'])(
    'keeps seven unique consecutive dates across DST at %s', (instant) => {
      const week = mealWeek('America/New_York', 0, new Date(instant));
      expect(week.days).toHaveLength(7);
      expect(new Set(week.days).size).toBe(7);
      expect(formatMealDay(week.start, 'en-US', { weekday: 'long' })).toBe('Monday');
      expect(weekDates(week.start)).toEqual(week.days);
    },
  );

  it('moves weeks through a year boundary without changing today', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    expect(mealWeek('UTC', -1, now).start).toBe('2025-12-22');
    expect(mealWeek('UTC', 0, now).start).toBe('2025-12-29');
    expect(mealWeek('UTC', 1, now)).toMatchObject({ start: '2026-01-05', today: '2026-01-01' });
  });

  it('falls back to the schema UTC default for invalid household zones', () => {
    const now = new Date('2026-09-14T00:30:00Z');
    expect(mealWeek('Unavailable/Zone', 0, now)).toEqual(mealWeek('UTC', 0, now));
  });

  it('does not reinterpret date labels in a supplied viewer timezone', () => {
    expect(formatMealDay('2026-09-14', 'en-US', { weekday: 'long', timeZone: 'America/Los_Angeles' })).toBe('Monday');
    expect(formatMealDay('2026-09-14', 'fr-FR', { weekday: 'long' })).toBe('lundi');
  });

  it('rejects impossible dates and preserves leap days', () => {
    expect(mealWeekDays('2026-02-30')).toEqual([]);
    expect(weekDates('bad')).toEqual([]);
    expect(formatMealDay('2026-02-30', 'en-US', { day: 'numeric' })).toBe('');
    expect(mealWeekDays('2028-02-28').slice(0, 3)).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
  });
});
