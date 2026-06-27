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
    ], NOW)).toEqual([]);
  });
});

describe('reminderFetchHorizonIso', () => {
  it('extends the window by a week to cover early reminders', () => {
    expect(reminderFetchHorizonIso(NOW)).toBe('2026-07-09T09:00:00.000Z');
  });
});
