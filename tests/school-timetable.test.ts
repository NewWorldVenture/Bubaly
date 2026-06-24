import { describe, it, expect } from 'vitest';
import {
  weekParity, classOccursInWeek, slotStartMinutes, buildWeekGrid,
  WEEKDAYS, WEEKDAY_LABELS, WEEK_PATTERN_LABELS,
  type ClassLike,
} from '@/lib/school/timetable';

const mk = (over: Partial<ClassLike> = {}): ClassLike => ({
  id: 'c1', member_id: 'm1', subject: 'Math',
  time_slot: '9:00 AM', day_of_week: 1, week_pattern: 'all', ...over,
});

describe('weekParity', () => {
  it('returns a stable a/b for a date', () => {
    expect(weekParity(new Date('2026-06-22T00:00:00Z'))).toMatch(/^(a|b)$/);
  });
  it('alternates between consecutive weeks', () => {
    const w1 = weekParity(new Date('2026-06-22T00:00:00Z')); // Monday
    const w2 = weekParity(new Date('2026-06-29T00:00:00Z')); // next Monday
    expect(w1).not.toBe(w2);
  });
  it('is consistent across days within the same week', () => {
    const mon = weekParity(new Date('2026-06-22T00:00:00Z'));
    const fri = weekParity(new Date('2026-06-26T00:00:00Z'));
    expect(mon).toBe(fri);
  });
});

describe('classOccursInWeek', () => {
  it('"all" classes occur every week', () => {
    expect(classOccursInWeek(mk({ week_pattern: 'all' }), 'a')).toBe(true);
    expect(classOccursInWeek(mk({ week_pattern: 'all' }), 'b')).toBe(true);
  });
  it('"a" classes only occur on a-weeks', () => {
    expect(classOccursInWeek(mk({ week_pattern: 'a' }), 'a')).toBe(true);
    expect(classOccursInWeek(mk({ week_pattern: 'a' }), 'b')).toBe(false);
  });
  it('"b" classes only occur on b-weeks', () => {
    expect(classOccursInWeek(mk({ week_pattern: 'b' }), 'b')).toBe(true);
    expect(classOccursInWeek(mk({ week_pattern: 'b' }), 'a')).toBe(false);
  });
});

describe('slotStartMinutes', () => {
  it('parses 24-hour times', () => {
    expect(slotStartMinutes('13:30')).toBe(13 * 60 + 30);
    expect(slotStartMinutes('09:00')).toBe(9 * 60);
  });
  it('parses 12-hour AM/PM times', () => {
    expect(slotStartMinutes('9:00 AM')).toBe(9 * 60);
    expect(slotStartMinutes('1:30 PM')).toBe(13 * 60 + 30);
    expect(slotStartMinutes('12:00 AM')).toBe(0);
    expect(slotStartMinutes('12:00 PM')).toBe(12 * 60);
  });
  it('parses a leading time from a range', () => {
    expect(slotStartMinutes('9:00-9:50')).toBe(9 * 60);
  });
  it('sorts untimed/unparseable classes last', () => {
    expect(slotStartMinutes(null)).toBeGreaterThan(24 * 60);
    expect(slotStartMinutes('Period 1')).toBeGreaterThan(24 * 60);
  });
});

describe('buildWeekGrid', () => {
  const classes: ClassLike[] = [
    mk({ id: 'mon-late', subject: 'PE', day_of_week: 1, time_slot: '2:00 PM' }),
    mk({ id: 'mon-early', subject: 'Math', day_of_week: 1, time_slot: '9:00 AM' }),
    mk({ id: 'tue', subject: 'Art', day_of_week: 2, time_slot: '10:00 AM' }),
    mk({ id: 'aweek', subject: 'Lab', day_of_week: 3, time_slot: '11:00 AM', week_pattern: 'a' }),
    mk({ id: 'daily', subject: 'Reading', day_of_week: null, time_slot: '8:00 AM' }),
  ];

  it('groups by weekday Mon–Fri', () => {
    const grid = buildWeekGrid(classes, 'a');
    expect(Object.keys(grid).map(Number).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('sorts each day by start time', () => {
    const grid = buildWeekGrid(classes, 'a');
    const monIds = grid[1].map((c) => c.id);
    // daily (8:00) < mon-early (9:00) < mon-late (2:00 PM)
    expect(monIds).toEqual(['daily', 'mon-early', 'mon-late']);
  });

  it('includes daily (no day_of_week) classes on every weekday', () => {
    const grid = buildWeekGrid(classes, 'a');
    for (const day of WEEKDAYS) {
      expect(grid[day].some((c) => c.id === 'daily')).toBe(true);
    }
  });

  it('filters out classes that do not occur in the selected week', () => {
    const aGrid = buildWeekGrid(classes, 'a');
    const bGrid = buildWeekGrid(classes, 'b');
    expect(aGrid[3].some((c) => c.id === 'aweek')).toBe(true);
    expect(bGrid[3].some((c) => c.id === 'aweek')).toBe(false);
  });
});

describe('labels', () => {
  it('exposes weekday and week-pattern labels', () => {
    expect(WEEKDAY_LABELS[1]).toBe('Mon');
    expect(WEEKDAY_LABELS[5]).toBe('Fri');
    expect(WEEK_PATTERN_LABELS.all).toBe('Every week');
    expect(WEEK_PATTERN_LABELS.a).toBe('A weeks');
    expect(WEEK_PATTERN_LABELS.b).toBe('B weeks');
  });
});
