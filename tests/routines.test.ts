import { describe, it, expect } from 'vitest';
import {
  detectRoutines, materializeRoutine,
  weekdayMaskLabel, weekdaysInMask, hasWeekday, toggleWeekday, minutesToLabel,
  jsDayToWeekday, WEEKDAYS_WEEKDAYS, WEEKDAYS_ALL, WEEKDAYS_WEEKEND,
  type RoutineEventInput,
} from '@/lib/routines/detect';

// Build a timed event at a given local date/time.
function ev(id: string, title: string, y: number, m: number, d: number, hh: number, mm: number, durMin = 30, assignee: string | null = null): RoutineEventInput {
  const start = new Date(y, m - 1, d, hh, mm);
  return {
    id, title, category: 'general',
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + durMin * 60000).toISOString(),
    all_day: false, assignee_id: assignee,
  };
}

describe('detectRoutines', () => {
  it('flags a title/weekday/time seen on ≥3 distinct weeks', () => {
    // Same Monday 08:00 across 3 weeks in Jan 2025 (6th, 13th, 20th are Mondays).
    const events = [
      ev('1', 'School Drop-off', 2025, 1, 6, 8, 0),
      ev('2', 'School Drop-off', 2025, 1, 13, 8, 0),
      ev('3', 'School Drop-off', 2025, 1, 20, 8, 0),
    ];
    const s = detectRoutines(events);
    expect(s).toHaveLength(1);
    expect(s[0].title).toBe('School Drop-off');
    expect(s[0].weekday).toBe(0); // Monday
    expect(s[0].startMinutes).toBe(480); // 08:00
    expect(s[0].occurrences).toBe(3);
  });

  it('ignores one-offs and things under the threshold', () => {
    const events = [
      ev('1', 'Dentist', 2025, 1, 6, 9, 0),
      ev('2', 'Dentist', 2025, 1, 13, 9, 0), // only 2 weeks
    ];
    expect(detectRoutines(events)).toHaveLength(0);
  });

  it('buckets near times together (7:58 and 8:02 → same routine)', () => {
    const events = [
      ev('1', 'Gym', 2025, 1, 6, 7, 58),
      ev('2', 'Gym', 2025, 1, 13, 8, 2),
      ev('3', 'Gym', 2025, 1, 20, 8, 0),
    ];
    const s = detectRoutines(events);
    expect(s).toHaveLength(1);
    expect(s[0].occurrences).toBe(3);
  });

  it('ignores all-day events', () => {
    const base = ev('1', 'Holiday', 2025, 1, 6, 0, 0);
    const events = [1, 2, 3].map((n) => ({ ...base, id: String(n), all_day: true }));
    expect(detectRoutines(events)).toHaveLength(0);
  });

  it('picks the majority assignee and median duration', () => {
    const events = [
      ev('1', 'Practice', 2025, 1, 7, 16, 0, 60, 'liam'),
      ev('2', 'Practice', 2025, 1, 14, 16, 0, 90, 'liam'),
      ev('3', 'Practice', 2025, 1, 21, 16, 0, 60, 'ava'),
    ];
    const s = detectRoutines(events);
    expect(s[0].assigneeId).toBe('liam');
    expect(s[0].durationMinutes).toBe(60);
  });
});

describe('weekday mask helpers', () => {
  it('labels common masks', () => {
    expect(weekdayMaskLabel(WEEKDAYS_ALL)).toBe('Every day');
    expect(weekdayMaskLabel(WEEKDAYS_WEEKDAYS)).toBe('Weekdays');
    expect(weekdayMaskLabel(WEEKDAYS_WEEKEND)).toBe('Weekends');
    expect(weekdayMaskLabel(0)).toBe('No days');
    expect(weekdayMaskLabel(0b0000101)).toBe('Mon, Wed');
  });
  it('toggles and reads bits', () => {
    let m = 0;
    m = toggleWeekday(m, 0); // Mon
    m = toggleWeekday(m, 2); // Wed
    expect(hasWeekday(m, 0)).toBe(true);
    expect(hasWeekday(m, 1)).toBe(false);
    expect(weekdaysInMask(m)).toEqual([0, 2]);
    m = toggleWeekday(m, 0);
    expect(hasWeekday(m, 0)).toBe(false);
  });
  it('jsDayToWeekday maps Sunday(0) → 6, Monday(1) → 0', () => {
    expect(jsDayToWeekday(0)).toBe(6);
    expect(jsDayToWeekday(1)).toBe(0);
    expect(jsDayToWeekday(6)).toBe(5);
  });
  it('formats minutes', () => {
    expect(minutesToLabel(0)).toBe('12:00 AM');
    expect(minutesToLabel(480)).toBe('8:00 AM');
    expect(minutesToLabel(750)).toBe('12:30 PM');
    expect(minutesToLabel(1290)).toBe('9:30 PM');
  });
});

describe('materializeRoutine', () => {
  const monday = new Date(2025, 0, 6); // Mon Jan 6 2025, local midnight
  const template = {
    weekday_mask: WEEKDAYS_WEEKDAYS, // Mon–Fri
    items: [
      { title: 'Wake up', category: 'general' as const, start_minutes: 420, duration_minutes: 15, assignee_id: null },
      { title: 'Breakfast', category: 'general' as const, start_minutes: 450, duration_minutes: 30, assignee_id: 'liam' },
    ],
  };

  it('emits item × active-weekday events for one week', () => {
    const rows = materializeRoutine(template, monday, 1);
    expect(rows).toHaveLength(2 * 5); // 2 items × 5 weekdays
    const first = rows[0];
    expect(new Date(first.starts_at).getHours()).toBe(7);
    expect(new Date(first.ends_at).getTime() - new Date(first.starts_at).getTime()).toBe(15 * 60000);
    expect(first.all_day).toBe(false);
  });

  it('spans multiple weeks', () => {
    expect(materializeRoutine(template, monday, 2)).toHaveLength(2 * 5 * 2);
  });

  it('honors the weekday mask (weekends only → Sat/Sun)', () => {
    const rows = materializeRoutine({ ...template, weekday_mask: WEEKDAYS_WEEKEND }, monday, 1);
    expect(rows).toHaveLength(2 * 2);
    // Every event lands on Sat(6) or Sun(0 js).
    for (const r of rows) {
      const day = new Date(r.starts_at).getDay();
      expect(day === 6 || day === 0).toBe(true);
    }
  });

  it('carries assignee through', () => {
    const rows = materializeRoutine(template, monday, 1);
    expect(rows.filter((r) => r.assignee_id === 'liam')).toHaveLength(5);
  });
});
