import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';
import { instantCalendarBounds } from '@/lib/briefing/calendar-window';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A CALENDAR READ IS NOT A SILENT PREFIX.
 *
 * PostgREST caps one response at `db-max-rows` — 1,000 on a hosted Supabase
 * project, which this repository does not override — and says nothing about
 * it: a 1,001-row answer is 1,000 rows and no error. The recurring-event read
 * in lib/calendar/occurrences.ts asked for 2,001 rows and called only an answer
 * above 2,000 oversized, so a household with 1,001–2,000 series read as its
 * first 1,000 and the planner, the conflict check and the reminders lost the
 * rest (review 5981467603 on #923). Both reads now ask for an exact count,
 * page on from where a cut answer stopped, and fail closed when the server
 * stops short of its own count.
 *
 * The fake's `maxRows` is that cap, applied the way the server applies it.
 */

const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const TZ = 'America/New_York';
/** The week of 21–27 September 2026 on New York's wall. */
const WEEK = instantCalendarBounds('2026-09-21T04:00:00.000Z', '2026-09-28T03:59:59.999Z', TZ);

const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const row = (i: number, extra: Record<string, unknown>) => ({
  id: id(i), family_id: FAMILY, title: `Event ${i}`, description: null, location: null, category: 'general', all_day: false,
  recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null, created_by: null,
  onboarding_key: null, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z', ...extra,
});
/** A weekly series from Tuesday 25 August, each at its own minute so starts are distinct. */
const series = (i: number) => row(i, {
  starts_at: new Date(Date.UTC(2026, 7, 25, 20, 0, i)).toISOString(), ends_at: new Date(Date.UTC(2026, 7, 25, 21, 0, i)).toISOString(), recurrence: 'weekly',
});
/** A one-off in the week under test. */
const single = (i: number) => row(i, {
  starts_at: new Date(Date.UTC(2026, 8, 23, 12, 0, i)).toISOString(), ends_at: new Date(Date.UTC(2026, 8, 23, 13, 0, i)).toISOString(),
});
const household = (rows: Record<string, unknown>[], maxRows?: number) => {
  const db = createInMemorySupabase({ maxRows });
  db.seed('families', [{ id: FAMILY, timezone: TZ }]);
  db.seed('calendar_events', rows);
  return db;
};
const client = (db: ReturnType<typeof household>) => db as unknown as SupabaseClient<Database>;
const many = (n: number, make: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, k) => make(k + 1));

describe('a calendar read is not a silent prefix', () => {
  it('control: one response from a default project is 1,000 rows, whatever was asked for', async () => {
    const db = household(many(1001, series), 1000);
    const { data } = await db.from('calendar_events').select('*').limit(2001);
    expect(data).toHaveLength(1000);
  });

  it('reads every series of a household with 1,001 of them, so the last one is on the calendar', async () => {
    const res = await readCalendarOccurrences(client(household(many(1001, series), 1000)), FAMILY, WEEK, TZ);
    expect(res.error).toBeNull();
    expect(res.count).toBe(1001);
    expect(res.data?.map((r) => r.title)).toContain('Event 1001');
  });

  it('reads every one-off the same way', async () => {
    const res = await readCalendarOccurrences(client(household(many(1001, single), 1000)), FAMILY, WEEK, TZ);
    expect(res.error).toBeNull();
    expect(res.count).toBe(1001);
    expect(res.data?.map((r) => r.title)).toContain('Event 1001');
  });

  it('a project with a lower cap is read in more, smaller pages, still whole', async () => {
    const res = await readCalendarOccurrences(client(household(many(1001, series), 500)), FAMILY, WEEK, TZ);
    expect(res.error).toBeNull();
    expect(res.count).toBe(1001);
    expect(res.data?.map((r) => r.title)).toContain('Event 1001');
  });

  it('a household under the cap is read in one request per table read', async () => {
    const db = household([...many(3, series), ...many(2, single).map((r) => ({ ...r, id: id(100 + Number(String(r.title).slice(6))) }))], 1000);
    const requests: string[] = [];
    const counted = { from: (table: string) => { requests.push(table); return db.from(table); } } as unknown as SupabaseClient<Database>;
    const res = await readCalendarOccurrences(counted, FAMILY, WEEK, TZ);
    expect(res.error).toBeNull();
    expect(res.count).toBe(5);
    expect(requests).toEqual(['calendar_events', 'calendar_events']);
  });

  it('fails closed when the server stops short of its own count, instead of answering a prefix', async () => {
    // A server that counts 1,001 rows but answers the same first page whatever
    // range is asked for: the read must not grow by repeating what it has.
    const db = household(many(1001, series), 1000);
    const stuck = { from: (table: string) => { const b = db.from(table) as unknown as { range: (from: number, to: number) => unknown }; b.range = () => b; return b; } } as unknown as SupabaseClient<Database>;
    const res = await readCalendarOccurrences(stuck, FAMILY, WEEK, TZ);
    expect(res.data).toBeNull();
    expect(res.error?.message).toBe('The database answered 1000 of the 1001 recurring events it counted; the window cannot be read whole');
  });

  it('fails closed past the ceiling without reading the rest', async () => {
    const res = await readCalendarOccurrences(client(household(many(2001, series), 1000)), FAMILY, WEEK, TZ);
    expect(res.data).toBeNull();
    expect(res.error?.message).toBe('More than 2000 recurring events; the window cannot be read whole');
  });

  it('a household under the page size reads in one page, with the count the badge shows', async () => {
    const res = await readCalendarOccurrences(client(household([...many(3, series), ...many(2, single).map((r) => ({ ...r, id: id(100 + Number(String(r.title).slice(6))) }))], 1000)), FAMILY, WEEK, TZ, { limit: 2 });
    expect(res.error).toBeNull();
    expect(res.count).toBe(5);
    expect(res.data).toHaveLength(2);
  });
});
