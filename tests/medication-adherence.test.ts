import { describe, it, expect } from 'vitest';
import {
  shortTime, localDateKey, scheduleCoversDay, dosesForDay, doseSlotInstant,
  adherenceRate, doseStatusCounts, type ScheduleLike, type DoseLogLike,
} from '@/lib/medications/adherence';

describe('shortTime', () => {
  it('trims seconds and pads', () => {
    expect(shortTime('08:00:00')).toBe('08:00');
    expect(shortTime('9:5')).toBe('09:05');
  });
});

describe('localDateKey', () => {
  it('formats local Y-M-D', () => {
    expect(localDateKey(new Date(2026, 5, 21, 23, 0))).toBe('2026-06-21');
  });
});

describe('scheduleCoversDay', () => {
  const base: ScheduleLike = {
    id: 's1', medication_id: 'm1', time_of_day: '08:00',
    days_of_week: [1, 3, 5], starts_on: '2026-06-01', ends_on: null,
  };
  it('matches weekday within active window', () => {
    expect(scheduleCoversDay(base, '2026-06-22', 1)).toBe(true); // Monday
  });
  it('rejects weekdays not in the set', () => {
    expect(scheduleCoversDay(base, '2026-06-23', 2)).toBe(false); // Tuesday
  });
  it('respects starts_on / ends_on bounds', () => {
    expect(scheduleCoversDay(base, '2026-05-31', 1)).toBe(false);
    expect(scheduleCoversDay({ ...base, ends_on: '2026-06-10' }, '2026-06-22', 1)).toBe(false);
  });
});

describe('dosesForDay', () => {
  const schedules: ScheduleLike[] = [
    { id: 's1', medication_id: 'm1', time_of_day: '20:00', days_of_week: [0, 1, 2, 3, 4, 5, 6], starts_on: '2026-06-01', ends_on: null },
    { id: 's2', medication_id: 'm1', time_of_day: '08:00', days_of_week: [0, 1, 2, 3, 4, 5, 6], starts_on: '2026-06-01', ends_on: null },
    { id: 's3', medication_id: 'm2', time_of_day: '12:00', days_of_week: [1], starts_on: '2026-06-01', ends_on: null }, // Mondays only
  ];
  const sunday = new Date(2026, 5, 21); // 2026-06-21 is a Sunday

  it('returns active doses sorted by time, excludes non-matching weekdays', () => {
    const due = dosesForDay(schedules, [], sunday);
    expect(due.map((d) => d.time)).toEqual(['08:00', '20:00']); // s3 excluded (Mon only)
    expect(due.every((d) => d.status === 'pending')).toBe(true);
  });

  it('joins existing logs by slot', () => {
    const logs: DoseLogLike[] = [
      { schedule_id: 's2', scheduled_for: '2026-06-21T08:00', status: 'taken' },
      { schedule_id: 's1', scheduled_for: '2026-06-21T20:00', status: 'skipped' },
    ];
    const due = dosesForDay(schedules, logs, sunday);
    expect(due.find((d) => d.scheduleId === 's2')!.status).toBe('taken');
    expect(due.find((d) => d.scheduleId === 's1')!.status).toBe('skipped');
  });

  it('matches logs by the family clock when a zone is given', () => {
    // 08:00 in New York on that Sunday is 12:00Z. The runner is UTC, so this is
    // exactly the browser/cron disagreement the zone argument closes.
    const logs: DoseLogLike[] = [{ schedule_id: 's2', scheduled_for: '2026-06-21T12:00:00.000Z', status: 'taken' }];
    expect(dosesForDay(schedules, logs, sunday, 'America/New_York').find((d) => d.scheduleId === 's2')!.status).toBe('taken');
    expect(dosesForDay(schedules, logs, sunday).find((d) => d.scheduleId === 's2')!.status).toBe('pending');
  });

  it('falls back to the runtime clock for an unusable zone rather than losing the slot', () => {
    const logs: DoseLogLike[] = [{ schedule_id: 's2', scheduled_for: '2026-06-21T08:00', status: 'taken' }];
    expect(dosesForDay(schedules, logs, sunday, 'Not/AZone').find((d) => d.scheduleId === 's2')!.status).toBe('taken');
    expect(dosesForDay(schedules, logs, sunday, null).find((d) => d.scheduleId === 's2')!.status).toBe('taken');
  });

  it('includes Monday-only schedule on a Monday', () => {
    const monday = new Date(2026, 5, 22);
    const due = dosesForDay(schedules, [], monday);
    expect(due.map((d) => d.medicationId)).toContain('m2');
  });
});

describe('adherenceRate', () => {
  it('returns null when nothing logged', () => {
    expect(adherenceRate([])).toBeNull();
  });
  it('computes taken / total as a rounded percent', () => {
    expect(adherenceRate([
      { status: 'taken' }, { status: 'taken' }, { status: 'skipped' }, { status: 'missed' },
    ])).toBe(50);
    expect(adherenceRate([{ status: 'taken' }, { status: 'taken' }, { status: 'missed' }])).toBe(67);
  });
});

describe('doseStatusCounts', () => {
  it('tallies each status', () => {
    expect(doseStatusCounts([
      { status: 'taken' }, { status: 'taken' }, { status: 'skipped' }, { status: 'missed' },
    ])).toEqual({ taken: 2, skipped: 1, missed: 1 });
  });
});

describe('doseSlotInstant', () => {
  it('resolves a slot in the given zone, not the runtime one', () => {
    expect(doseSlotInstant('2026-06-21T08:00', 'America/New_York')).toBe('2026-06-21T12:00:00.000Z');
    expect(doseSlotInstant('2026-06-21T08:00')).toBe('2026-06-21T08:00:00.000Z'); // runner is UTC
  });

  it('refuses a slot that does not exist in that zone rather than moving it', () => {
    // 2026-03-08 02:30 never happens in New York — the clocks jump 02:00 → 03:00.
    expect(doseSlotInstant('2026-03-08T02:30', 'America/New_York')).toBeNull();
    expect(doseSlotInstant('2026-02-30T08:00', 'America/New_York')).toBeNull();
    expect(doseSlotInstant('not-a-slot', 'America/New_York')).toBeNull();
  });
});
