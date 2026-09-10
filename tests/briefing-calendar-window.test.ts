import { describe, expect, it, vi } from 'vitest';
import { briefingCalendarWindow } from '@/lib/briefing/calendar-window';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

describe('calendar query bounds', () => {
  it.each([
    ['America/Santiago', '2026-09-06'], ['America/Havana', '2026-03-08'], ['America/Havana', '2026-11-01'],
    ['America/New_York', '2026-03-08'], ['America/New_York', '2026-11-01'], ['Asia/Kathmandu', '2026-09-09'],
    ['Pacific/Kiritimati', '2026-09-09'], ['Pacific/Pago_Pago', '2026-09-09'], ['UTC', '2026-09-09'],
  ])('%s selects the actual local date %s independently of its clock transition', async (zone, day) => {
    const db = createInMemorySupabase();
    const start = Date.parse(`${day}T00:00:00.000Z`) - 86_400_000;
    const rows = Array.from({ length: 72 * 4 }, (_, i) => ({ id: String(i), starts_at: new Date(start + i * 900_000).toISOString(), all_day: false }));
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const expected = rows.filter(row => formatter.format(new Date(row.starts_at)) === day).map(({ id }) => ({ id }));
    db.seed('events', rows);
    const result = await db.from('events').select('id').or(briefingCalendarWindow(day, zone, 0, 1)).order('starts_at');
    expect(result.data).toEqual(expected); expect(expected.length).toBeGreaterThan(0);
  });

  it('bounds formatter work without a scan over every minute in the day', () => {
    const parts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      briefingCalendarWindow('2026-09-06', 'America/Santiago', 0, 7);
      expect(parts.mock.calls.length).toBeLessThanOrEqual(62);
    } finally { parts.mockRestore(); }
  });

  it('a skipped whole date has no timed instants while stored all-day dates stay unchanged', async () => {
    const db = createInMemorySupabase();
    db.seed('events', [
      { id: 'stored date', all_day: true, starts_at: '2011-12-30T00:00:00.000Z' },
      { id: 'before jump', all_day: false, starts_at: '2011-12-30T09:59:59.999Z' },
      { id: 'after jump', all_day: false, starts_at: '2011-12-30T10:00:00.000Z' },
    ]);
    const result = await db.from('events').select('id').or(briefingCalendarWindow('2011-12-30', 'Pacific/Apia', 0, 1));
    expect(result.data).toEqual([{ id: 'stored date' }]);
  });

  it.each([
    ['2026-02-30', 'UTC', 0, 1], ['bad', 'UTC', 0, 1], ['2026-09-09', 'Invalid/Zone', 0, 1],
    ['2026-09-09', 'UTC', Number.NaN, 1], ['2026-09-09', 'UTC', 0, Infinity], ['2026-09-09', 'UTC', -1, 1],
    ['2026-09-09', 'UTC', 0, 0], ['2026-09-09', 'UTC', 0.5, 1], ['2026-09-09', 'UTC', 0, Number.MAX_SAFE_INTEGER],
  ] as const)('rejects a nonrepresentable or nonfinite window: %s %s %s %s', (day, zone, offset, length) => {
    expect(() => briefingCalendarWindow(day, zone, offset, length)).toThrow(RangeError);
  });
});
