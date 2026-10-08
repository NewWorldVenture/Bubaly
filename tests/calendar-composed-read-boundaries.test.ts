import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { readCalendarOccurrences, readCalendarBusySource, readCountedRows } from '@/lib/calendar/occurrences';
import { instantCalendarBounds, briefingCalendarBounds } from '@/lib/briefing/calendar-window';
import { familyFetchRange } from '@/lib/calendar/day';
import { allDayBusyInterval } from '@/lib/calendar/event-dates';
import { parseICS } from '@/lib/sync/ics';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const family = 'family';
const row = (id: string, starts_at: string, extra = {}) => ({
  id, family_id: family, starts_at, ends_at: null, all_day: false, recurrence: 'none', recurrence_until: null, ...extra,
});
const client = (db: ReturnType<typeof createInMemorySupabase>) => db as unknown as SupabaseClient<Database>;

describe('composed calendar read boundaries', () => {
  it('reads a later-fold series seed in its saved window and keeps its busy overlap', async () => {
    const db = createInMemorySupabase({ maxRows: 1 });
    const seed = row('fold', '2026-11-01T06:30:42.125Z', { ends_at: '2026-11-01T07:00:00.000Z', recurrence: 'weekly' });
    db.seed('calendar_events', [seed]);
    const zone = 'America/New_York';
    const atStart = await readCalendarOccurrences(client(db), family,
      instantCalendarBounds('2026-11-01T06:30:00.000Z', '2026-11-01T06:31:00.000Z', zone), zone);
    expect(atStart.error).toBeNull();
    expect(atStart.count).toBe(1);
    expect(atStart.data).toMatchObject([seed]);
    const busy = await readCalendarOccurrences(client(db), family,
      instantCalendarBounds('2026-11-01T06:45:00.000Z', '2026-11-01T06:46:00.000Z', zone), zone, { overlap: true });
    expect(busy.error).toBeNull();
    expect(busy.count).toBe(1);
    expect(busy.data).toMatchObject([seed]);
  });

  it('completes a bounded nearest-singles read below the requested server cap', async () => {
    const db = createInMemorySupabase({ maxRows: 2 });
    db.seed('calendar_events', Array.from({ length: 7 }, (_, n) => row(`event-${n}`, `2026-10-10T${String(n + 10).padStart(2, '0')}:00:00.000Z`)));
    const bounds = briefingCalendarBounds('2026-10-10', 'UTC', 0, 1);
    const result = await readCalendarOccurrences(client(db), family, bounds, 'UTC', { singlesLimit: 5, limit: 5 });
    expect(result.error).toBeNull();
    expect(result.data?.map(r => r.id)).toEqual(['event-0', 'event-1', 'event-2', 'event-3', 'event-4']);
  });

  it.each([
    [{ data: null, count: 0, error: null }, 'page was unavailable'],
    [{ data: [{ id: 'same' }, { id: 'same' }], count: 2, error: null }, 'repeated row same'],
    [{ data: [{}], count: 1, error: null }, 'no identity'],
    [{ data: [{ id: 'x' }], count: null, error: null }, 'usable count'],
  ])('refuses malformed and duplicate page responses', async (response, message) => {
    const result = await readCountedRows(() => Promise.resolve(response), () => Promise.resolve(response), 20, 'events');
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain(message);
  });

  it('returns an error shape for a rejected bounded read', async () => {
    const result = await readCountedRows(() => Promise.reject(new Error('transport interrupted')), () => Promise.reject(), 20, 'events', 5);
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain('transport interrupted');
  });

  it('includes one-off, prior series and multi-day all-day intervals already in progress', async () => {
    const db = createInMemorySupabase({ maxRows: 1 });
    db.seed('calendar_events', [
      row('one', '2026-10-10T08:00:00.000Z', { ends_at: '2026-10-10T11:00:00.000Z' }),
      row('series', '2026-10-03T09:00:00.000Z', { ends_at: '2026-10-03T12:00:00.000Z', recurrence: 'weekly', recurrence_until: '2026-10-10T09:30:00.000Z' }),
      row('holiday', '2026-10-09T00:00:00.000Z', { ends_at: '2026-10-12T00:00:00.000Z', all_day: true }),
      row('ended', '2026-10-10T08:00:00.000Z', { ends_at: '2026-10-10T10:00:00.000Z' }),
    ]);
    const bounds = instantCalendarBounds('2026-10-10T10:00:00.000Z', '2026-10-10T10:59:59.999Z', 'UTC');
    const result = await readCalendarOccurrences(client(db), family, bounds, 'UTC', { overlap: true });
    expect(result.error).toBeNull();
    expect(result.data?.map(r => r.id)).toEqual(['holiday', 'one', 'series']);
    expect(result.data?.find(r => r.id === 'series')?.starts_at).toBe('2026-10-10T09:00:00.000Z');
  });

  it.each(['school_events', 'sports_events'] as const)('pages every overlapping %s commitment', async table => {
    const db = createInMemorySupabase({ maxRows: 1 });
    db.seed(table, ['a', 'b', 'c'].map(id => ({ id, family_id: family, starts_at: '2026-10-10T08:00:00.000Z', ends_at: '2026-10-10T12:00:00.000Z', member_id: null })));
    const result = await readCalendarBusySource(client(db), family, table, '2026-10-10T10:00:00.000Z', '2026-10-10T11:00:00.000Z');
    expect(result.error).toBeNull();
    expect(result.data?.map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps exclusive multi-day all-day ends across the DST weekend', () => {
    const interval = allDayBusyInterval({ starts_at: '2026-03-07T00:00:00.000Z', ends_at: '2026-03-10T00:00:00.000Z', all_day: true }, 'America/New_York');
    expect(interval).toEqual({ start: Date.parse('2026-03-07T05:00:00.000Z'), end: Date.parse('2026-03-10T04:00:00.000Z') });
    expect((interval.end - interval.start) / 3_600_000).toBe(71);
  });

  it('a skipped local date never fabricates a UTC timed window', () => {
    const range = familyFetchRange('2011-12-30', '2011-12-31', 'Pacific/Apia');
    expect(range.timedFrom.toISOString()).toBe(range.timedTo.toISOString());
    expect(range.allDayFrom.toISOString()).toBe('2011-12-30T00:00:00.000Z');
  });
});

describe('recurrence identities use the strict ICS clock', () => {
  const calendar = (...properties: string[]) => ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:series', ...properties, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

  it('places a bare cancelled fold occurrence at its first instant', () => {
    const parsed = parseICS(calendar('RECURRENCE-ID;TZID=America/New_York:20261101T013000', 'STATUS:CANCELLED'), { bareCancellations: true });
    expect(parsed[0]).toMatchObject({ uid: 'series', recurrenceId: '2026-11-01T05:30:00.000Z', startsAt: '2026-11-01T05:30:00.000Z', status: 'cancelled' });
  });

  it.each([
    'RECURRENCE-ID;TZID=Unknown/Zone:20261101T013000',
    'RECURRENCE-ID;TZID=America/New_York;TZID=UTC:20261101T013000',
    'RECURRENCE-ID;VALUE=DATE:20260230',
    'RECURRENCE-ID;RANGE=THISANDFUTURE:20261101T013000Z',
  ])('refuses unsafe recurrence identity: %s', property => {
    expect(() => parseICS(calendar(property, 'STATUS:CANCELLED'), { bareCancellations: true })).toThrow();
  });
});
