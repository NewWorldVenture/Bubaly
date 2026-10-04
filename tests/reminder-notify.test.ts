import { describe, it, expect } from 'vitest';
import { dueFamilyReminderNotices, reminderFetchHorizonIso, type FamilyReminderRow } from '@/lib/reminders/notify';

const NOW = new Date('2026-07-01T09:00:00.000Z');
const row = (over: Partial<FamilyReminderRow>): FamilyReminderRow => ({
  id: 'r', title: 'Pay rent', remind_at: '2026-07-01T20:00:00.000Z', status: 'active', early_reminder_minutes: null, member_id: null, ...over,
});

describe('dueFamilyReminderNotices', () => {
  it('includes reminders due within the 24h window', () => {
    const out = dueFamilyReminderNotices([row({ id: 'soon', remind_at: '2026-07-01T20:00:00.000Z' })], NOW);
    expect(out.map((n) => n.id)).toEqual(['soon']);
  });

  it('excludes reminders past or beyond the window', () => {
    const out = dueFamilyReminderNotices([
      row({ id: 'past', remind_at: '2026-07-01T08:00:00.000Z' }),
      row({ id: 'far', remind_at: '2026-07-05T09:00:00.000Z' }),
    ], NOW);
    expect(out).toEqual([]);
  });

  it('honors the early-reminder lead time', () => {
    // Due in 3 days, but "1 day before" → effective notify is 2 days out → not yet.
    expect(dueFamilyReminderNotices([row({ id: 'a', remind_at: '2026-07-04T09:00:00.000Z', early_reminder_minutes: 1440 })], NOW)).toEqual([]);
    // Due in 25h with "2 hours before" → effective is 23h out → in window.
    const out = dueFamilyReminderNotices([row({ id: 'b', remind_at: '2026-07-02T10:00:00.000Z', early_reminder_minutes: 120 })], NOW);
    expect(out.map((n) => n.id)).toEqual(['b']);
    expect(out[0].effectiveAtIso).toBe('2026-07-02T08:00:00.000Z');
  });

  it('skips non-active or date-less reminders', () => {
    expect(dueFamilyReminderNotices([
      row({ id: 'done', status: 'completed' }),
      row({ id: 'nodate', remind_at: null }),
      row({ id: 'dismissed', status: 'dismissed' }),
    ], NOW)).toEqual([]);
  });

  it('keys a one-off by the reminder and a recurring one by the occurrence it has rolled to', () => {
    // The caller dedupes PERMANENTLY on the key. A recurring reminder is one row
    // whose remind_at rolls forward on completion, so keyed by the row alone
    // its second occurrence — and every one after — was never sent.
    const [oneOff] = dueFamilyReminderNotices([row({ id: 'r1', recurrence: 'none' })], NOW);
    expect(oneOff.key).toBe('fr:r1');
    const [legacy] = dueFamilyReminderNotices([row({ id: 'r0' })], NOW);
    expect(legacy.key, 'a row without the column reads as one-off').toBe('fr:r0');
    const [daily] = dueFamilyReminderNotices([row({ id: 'r2', recurrence: 'daily', remind_at: '2026-07-01T20:00:00.000Z' })], NOW);
    expect(daily.key).toBe('fr:r2:2026-07-01T20:00:00.000Z');
    const [next] = dueFamilyReminderNotices([row({ id: 'r2', recurrence: 'daily', remind_at: '2026-07-02T20:00:00.000Z' })], new Date('2026-07-02T09:00:00.000Z'));
    expect(next.key, 'the next day is a new notice').toBe('fr:r2:2026-07-02T20:00:00.000Z');
    expect(next.key).not.toBe(daily.key);
  });

  it('a snoozed reminder comes back at snoozed_until, with no early lead, under a key of its own', () => {
    const snoozed = row({ id: 's1', status: 'snoozed', remind_at: '2026-06-30T20:00:00.000Z', snoozed_until: '2026-07-01T10:30:00.000Z', early_reminder_minutes: 120 });
    const out = dueFamilyReminderNotices([snoozed], NOW);
    expect(out).toEqual([{ id: 's1', title: 'Pay rent', remindAtIso: '2026-07-01T10:30:00.000Z', effectiveAtIso: '2026-07-01T10:30:00.000Z', key: 'fr:s1:snoozed:2026-07-01T10:30:00.000Z' }]);
    // Snoozed past the window, or snoozed without a time, is not due.
    expect(dueFamilyReminderNotices([row({ ...snoozed, snoozed_until: '2026-07-03T10:30:00.000Z' })], NOW)).toEqual([]);
    expect(dueFamilyReminderNotices([row({ ...snoozed, snoozed_until: null })], NOW)).toEqual([]);
  });
});

describe('reminderFetchHorizonIso', () => {
  it('extends the window by a week to cover early reminders', () => {
    expect(reminderFetchHorizonIso(NOW)).toBe('2026-07-09T09:00:00.000Z');
  });
});
