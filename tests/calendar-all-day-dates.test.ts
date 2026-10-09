import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { allDayBusyInterval, calendarEventDayKey } from '@/lib/calendar/event-dates';
import { busyIntervals, findFreeSlots as suggestSlots } from '@/lib/calendar/scheduling';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';
import { findFreeSlots } from '@/lib/services/calendar';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const event = (day: string) => ({ starts_at: `${day}T00:00:00.000Z`, ends_at: null, all_day: true });
const nativeFields = { title: 'Synthetic DATE', description: null, location: null, category: 'general', feed_id: null, external_uid: null, recurrence: 'none', recurrence_until: null,
  created_by: null, onboarding_key: null, idempotency_key: null, source_recurrence: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };

describe('all-day dates stay on their calendar date', () => {
  it.each(['America/New_York', 'America/Los_Angeles', 'Europe/Amsterdam', 'Asia/Tokyo', 'Asia/Kolkata'])('groups dates without applying the %s offset', (zone) => {
    expect(calendarEventDayKey(event('2026-09-09'), zone)).toBe('2026-09-09');
  });

  it('still groups timed instants by the family day', () => {
    const timed = { starts_at: '2026-09-09T00:00:00.000Z', all_day: false };
    expect(calendarEventDayKey(timed, 'America/New_York')).toBe('2026-09-08');
    expect(calendarEventDayKey(timed, 'Asia/Kolkata')).toBe('2026-09-09');
  });

  it.each([
    ['2026-03-08', 'America/New_York', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', 23],
    ['2026-11-01', 'America/New_York', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', 25],
    ['2026-09-09', 'Asia/Tokyo', '2026-09-08T15:00:00.000Z', '2026-09-09T15:00:00.000Z', 24],
    ['2026-09-09', 'Asia/Kolkata', '2026-09-08T18:30:00.000Z', '2026-09-09T18:30:00.000Z', 24],
  ] as const)('blocks %s in %s from its actual start to its next day', (day, zone, start, end, hours) => {
    const interval = allDayBusyInterval(event(day), zone);
    expect(interval).toEqual({ start: Date.parse(start), end: Date.parse(end) });
    expect((interval.end - interval.start) / 3_600_000).toBe(hours);
    expect(busyIntervals([event(day)], undefined, zone)).toEqual([interval]);
    expect(suggestSlots([event(day)], { windowStart: interval.start, windowEnd: interval.end, tz: zone,
      durationMin: 30, workingHours: { startHour: 0, endHour: 24 } })).toEqual([]);
  });

  it('preserves an exclusive multi-day end across the clock change', () => {
    const interval = allDayBusyInterval({ ...event('2026-10-31'), ends_at: '2026-11-03T00:00:00Z' }, 'America/New_York');
    expect(interval).toEqual({ start: Date.parse('2026-10-31T04:00:00Z'), end: Date.parse('2026-11-03T05:00:00Z') });
  });

  it.each(['America/New_York', 'Australia/Sydney', 'Asia/Kolkata'])('an all-day series keeps its stored dates across DST in %s', async (zone) => {
    const db = createInMemorySupabase();
    db.seed('calendar_events', [{ ...event('2026-10-25'), id: 'weekly-date', family_id: 'family', recurrence: 'weekly', recurrence_until: null }]);
    const result = await readCalendarOccurrences(db as unknown as SupabaseClient<Database>, 'family',
      briefingCalendarBounds('2026-11-01', zone, 0, 8), zone, { columns: ['id'] });
    expect(result.error).toBeNull();
    expect(result.data?.map((row) => calendarEventDayKey(row, zone))).toEqual(['2026-11-01', '2026-11-08']);
    expect(result.data?.map((row) => row.starts_at)).toEqual(['2026-11-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z']);
  });
});

describe('the calendar service refuses free slots on an all-day date', () => {
  it.each(['2026-03-08', '2026-11-01'])('reads and blocks the complete %s family day', async (day) => {
    const db = createInMemorySupabase();
    db.seed('calendar_events', [{ ...nativeFields, ...event(day), id: '40000000-0000-4000-8000-000000000001', family_id: 'family', assignee_id: null }]);
    const scope: ServiceScope = { db: db as unknown as SupabaseClient<Database>, familyId: 'family', userId: 'user', memberId: 'member',
      role: 'parent', actorKind: 'member', tz: 'America/New_York', now: new Date('2026-01-01T00:00:00Z') };
    const interval = allDayBusyInterval(event(day), scope.tz);
    const result = await findFreeSlots(scope, { durationMin: 30, from: new Date(interval.start).toISOString(),
      to: new Date(interval.end).toISOString(), workingHours: { startHour: 0, endHour: 24 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });

  it('blocks an all-day recurring date after its first week', async () => {
    const db = createInMemorySupabase();
    db.seed('calendar_events', [{ ...nativeFields, ...event('2026-10-25'), id: '40000000-0000-4000-8000-000000000002', family_id: 'family', assignee_id: null, recurrence: 'weekly', recurrence_until: null }]);
    const scope: ServiceScope = { db: db as unknown as SupabaseClient<Database>, familyId: 'family', userId: 'user', memberId: 'member',
      role: 'parent', actorKind: 'member', tz: 'America/New_York', now: new Date('2026-01-01T00:00:00Z') };
    const interval = allDayBusyInterval(event('2026-11-01'), scope.tz);
    const result = await findFreeSlots(scope, { durationMin: 30, from: new Date(interval.start).toISOString(),
      to: new Date(interval.end).toISOString(), workingHours: { startHour: 0, endHour: 24 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });

  it('reads a multi-day date that started before the search window', async () => {
    const db = createInMemorySupabase();
    db.seed('calendar_events', [{ ...nativeFields, ...event('2026-10-31'), ends_at: '2026-11-03T00:00:00Z', id: '40000000-0000-4000-8000-000000000003', family_id: 'family', assignee_id: null, recurrence: 'none' }]);
    const scope: ServiceScope = { db: db as unknown as SupabaseClient<Database>, familyId: 'family', userId: 'user', memberId: 'member',
      role: 'parent', actorKind: 'member', tz: 'America/New_York', now: new Date('2026-01-01T00:00:00Z') };
    const interval = allDayBusyInterval(event('2026-11-01'), scope.tz);
    const result = await findFreeSlots(scope, { durationMin: 30, from: new Date(interval.start).toISOString(),
      to: new Date(interval.end).toISOString(), workingHours: { startHour: 0, endHour: 24 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });
});
