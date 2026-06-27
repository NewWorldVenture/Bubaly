import { describe, it, expect } from 'vitest';
import { reminderAttention } from '@/lib/dashboard/reminder-attention';

describe('reminderAttention', () => {
  const now = new Date('2026-06-27T14:00:00.000Z');

  it('splits overdue vs due-later-today and ignores the rest', () => {
    const rows = [
      { remind_at: '2026-06-27T09:00:00.000Z', status: 'active' }, // earlier today → overdue
      { remind_at: '2026-06-27T13:59:00.000Z', status: 'active' }, // a minute ago → overdue
      { remind_at: '2026-06-27T20:00:00.000Z', status: 'active' }, // later today → dueToday
      { remind_at: '2026-06-28T09:00:00.000Z', status: 'active' }, // tomorrow → neither
      { remind_at: '2026-06-27T10:00:00.000Z', status: 'completed' }, // not active → ignored
      { remind_at: null, status: 'active' },                       // no time → ignored
    ];
    expect(reminderAttention(rows, now)).toEqual({ overdue: 2, dueToday: 1 });
  });

  it('counts the end-of-day boundary as due today', () => {
    expect(reminderAttention([{ remind_at: '2026-06-27T23:59:59.000Z', status: 'active' }], now))
      .toEqual({ overdue: 0, dueToday: 1 });
  });

  it('skips bad timestamps and returns zeros for an empty list', () => {
    expect(reminderAttention([{ remind_at: 'not-a-date', status: 'active' }], now)).toEqual({ overdue: 0, dueToday: 0 });
    expect(reminderAttention([], now)).toEqual({ overdue: 0, dueToday: 0 });
  });
});
