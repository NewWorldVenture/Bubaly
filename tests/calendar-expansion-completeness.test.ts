import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { expandEventsInZone } from '@/lib/calendar/recurrence';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const start = new Date('2026-01-01T00:00:00Z');
const end = (days: number) => new Date(start.getTime() + days * 86_400_000);
const seed = { id: 'daily', family_id: 'family', starts_at: start.toISOString(), ends_at: null, recurrence: 'daily', recurrence_until: null, all_day: false };

describe('complete recurrence expansion', () => {
  it('refuses a prefix when a daily series exceeds the work budget', () => {
    expect(() => expandEventsInZone([seed], start, end(501), 'UTC', false, { requireComplete: true })).toThrow(/cannot be read whole/);
  });

  it('accepts exactly 500 steps and keeps the legacy explicitly capped API', () => {
    expect(expandEventsInZone([seed], start, end(500), 'UTC', false, { requireComplete: true })).toHaveLength(500);
    expect(expandEventsInZone([seed], start, end(501), 'UTC')).toHaveLength(500);
  });

  it('accepts an early recurrence cutoff in a wide window', () => {
    expect(expandEventsInZone([{ ...seed, recurrence_until: end(2).toISOString() }], start, end(1000), 'UTC', false, { requireComplete: true })).toHaveLength(2);
  });

  it('looks past skipped leap dates to prove the boundary without truncating', () => {
    const leap = { ...seed, starts_at: '2000-02-29T12:00:00.000Z', recurrence: 'yearly' };
    const rows = expandEventsInZone([leap], new Date('2000-01-01'), new Date('2501-01-01'), 'UTC', false, { requireComplete: true });
    expect(rows.at(-1)?.starts_at).toBe('2496-02-29T12:00:00.000Z');
    expect(() => expandEventsInZone([leap], new Date('2000-01-01'), new Date('2505-01-01'), 'UTC', false, { requireComplete: true })).toThrow(/cannot be read whole/);
  });

  it.each([
    { ...seed, starts_at: 'invalid' },
    { ...seed, recurrence: 'unsupported' },
    { ...seed, recurrence_until: 'invalid' },
  ])('does not silently discard an unreadable series in a complete read', row => {
    expect(() => expandEventsInZone([row], start, end(1), 'UTC', false, { requireComplete: true })).toThrow(/cannot be read whole/);
  });

  it.each([false, true])('returns no rows or count when %s all-day expansion would be partial', async all_day => {
    const db = createInMemorySupabase();
    db.seed('calendar_events', [
      { ...seed, all_day },
      { ...seed, id: 'one-off', recurrence: 'none' },
    ]);
    const result = await readCalendarOccurrences(db as unknown as SupabaseClient<Database>, 'family',
      briefingCalendarBounds('2026-01-01', 'UTC', 0, 730), 'UTC', { limit: 1 });
    expect(result.data).toBeNull();
    expect(result.count).toBeNull();
    expect(result.error?.message).toMatch(/cannot be read whole/);
  });
});
