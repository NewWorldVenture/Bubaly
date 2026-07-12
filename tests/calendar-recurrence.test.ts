import { describe, it, expect } from 'vitest';
import { expandEvents, type RecurrableEvent } from '@/lib/calendar/recurrence';

const WIN_START = new Date('2026-07-01T00:00:00Z');
const WIN_END = new Date('2026-08-01T00:00:00Z');

const ev = (over: Partial<RecurrableEvent>): RecurrableEvent => ({
  id: 'e1',
  starts_at: '2026-07-06T17:00:00.000Z',
  ends_at: '2026-07-06T18:00:00.000Z',
  recurrence: 'none',
  recurrence_until: null,
  ...over,
});

describe('expandEvents — non-recurring', () => {
  it('passes through in-window events and drops out-of-window ones', () => {
    const inWin = ev({});
    const outWin = ev({ id: 'e2', starts_at: '2026-06-01T10:00:00.000Z' });
    const res = expandEvents([inWin, outWin], WIN_START, WIN_END);
    expect(res.map((e) => e.id)).toEqual(['e1']);
  });
});

describe('expandEvents — recurring', () => {
  it('a weekly event started BEFORE the window recurs into it', () => {
    // Started June 1 (Mon), weekly → July has Mondays 6/13/20/27 in-window.
    const weekly = ev({ starts_at: '2026-06-01T17:00:00.000Z', ends_at: '2026-06-01T18:00:00.000Z', recurrence: 'weekly' });
    const res = expandEvents([weekly], WIN_START, WIN_END);
    expect(res.length).toBe(4);
    expect(res.every((o) => o.id === 'e1')).toBe(true);
    expect(res[0].starts_at).toBe('2026-07-06T17:00:00.000Z');
    // Duration preserved on each occurrence.
    expect(res[0].ends_at).toBe('2026-07-06T18:00:00.000Z');
  });

  it('daily events fill the window and respect recurrence_until', () => {
    const daily = ev({ starts_at: '2026-07-01T08:00:00.000Z', recurrence: 'daily', recurrence_until: '2026-07-05T00:00:00.000Z' });
    const res = expandEvents([daily], WIN_START, WIN_END);
    expect(res.length).toBe(4); // Jul 1–4 (until is exclusive at 5th 00:00)
  });

  it('monthly on the 31st skips short months instead of drifting', () => {
    const monthly = ev({ starts_at: '2026-01-31T12:00:00.000Z', ends_at: null, recurrence: 'monthly' });
    // June window: June has 30 days → no occurrence.
    const june = expandEvents([monthly], new Date('2026-06-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z'));
    expect(june.length).toBe(0);
    // July window: July 31 exists.
    const july = expandEvents([monthly], WIN_START, WIN_END);
    expect(july.length).toBe(1);
    expect(july[0].starts_at.startsWith('2026-07-31')).toBe(true);
  });

  it('yearly recurs on the anniversary', () => {
    const yearly = ev({ starts_at: '2020-07-15T09:00:00.000Z', recurrence: 'yearly' });
    const res = expandEvents([yearly], WIN_START, WIN_END);
    expect(res.length).toBe(1);
    expect(res[0].starts_at.startsWith('2026-07-15')).toBe(true);
  });

  it('output is sorted and bounded', () => {
    const daily = ev({ starts_at: '2026-07-01T08:00:00.000Z', recurrence: 'daily' });
    const weekly = ev({ id: 'e2', starts_at: '2026-06-02T07:00:00.000Z', recurrence: 'weekly' });
    const res = expandEvents([daily, weekly], WIN_START, WIN_END);
    const sorted = [...res].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    expect(res).toEqual(sorted);
    expect(res.length).toBeLessThan(50);
  });
});
