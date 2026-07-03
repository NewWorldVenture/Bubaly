import { describe, it, expect } from 'vitest';
import { reminderLeadMinutes, reminderTimeFor } from '@/lib/moments/reminders';

const now = new Date('2026-07-01T09:00:00.000Z');
const start = '2026-07-04T15:00:00.000Z'; // 3+ days out

describe('reminderLeadMinutes', () => {
  it('is domain-specific with a default fallback', () => {
    expect(reminderLeadMinutes('packing')).toBe(14 * 60);
    expect(reminderLeadMinutes('shopping')).toBe(48 * 60);
    expect(reminderLeadMinutes('photo')).toBe(0);
    expect(reminderLeadMinutes('time')).toBe(20 * 60); // default
  });
});

describe('reminderTimeFor', () => {
  it('leave-by fires exactly at the leave time', () => {
    const iso = reminderTimeFor({ domain: 'time', stepId: 'leave-by', eventStartsAtISO: start, leaveByISO: '2026-07-04T14:25:00.000Z' }, now);
    expect(iso).toBe('2026-07-04T14:25:00.000Z');
  });
  it('packing fires the night before (14h out)', () => {
    const iso = reminderTimeFor({ domain: 'packing', stepId: 'pack', eventStartsAtISO: start }, now);
    expect(iso).toBe('2026-07-04T01:00:00.000Z'); // 15:00 − 14h
  });
  it('photo fires at the event start', () => {
    const iso = reminderTimeFor({ domain: 'photo', stepId: 'photo', eventStartsAtISO: start }, now);
    expect(iso).toBe(start);
  });
  it('clamps a same-day ideal that already passed to just after now', () => {
    const soon = '2026-07-01T10:00:00.000Z'; // 1h from now; packing lead (14h) is in the past
    const iso = reminderTimeFor({ domain: 'packing', stepId: 'pack', eventStartsAtISO: soon }, now);
    expect(Date.parse(iso)).toBe(now.getTime() + 60_000);
  });
  it('handles an invalid start by falling back to now+1m', () => {
    const iso = reminderTimeFor({ domain: 'shopping', stepId: 'shop', eventStartsAtISO: 'nope' }, now);
    expect(Date.parse(iso)).toBe(now.getTime() + 60_000);
  });
});
