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
 * stops short of its own count — or answers with no count a read could trust
 * (the recheck 5981632558: a missing count, or one that changes between pages,
 * accepted a prefix as the whole).
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

  it('fails closed when a page repeats a row an earlier page returned, and names the row', async () => {
    // A server that counts 1,001 rows but answers the same first page whatever
    // range is asked for: the read must not grow by repeating what it has, and
    // the refusal says which row came back twice.
    const db = household(many(1001, series), 1000);
    const stuck = { from: (table: string) => { const b = db.from(table) as unknown as { range: (from: number, to: number) => unknown }; b.range = () => b; return b; } } as unknown as SupabaseClient<Database>;
    const res = await readCalendarOccurrences(stuck, FAMILY, WEEK, TZ);
    expect(res.data).toBeNull();
    expect(res.count).toBeNull();
    expect(res.error?.message).toBe(`The database answered recurring event ${id(1)} again on the page from row 1000, after an earlier page had returned it; the window cannot be read whole`);
  });

  it('fails closed when a later page repeats only part of an earlier one, naming the first repeat', async () => {
    // Page two starts one row early (an offset off by one): its first row is
    // the last row of page one; the rest is new. Taking the new rows and
    // skipping the repeat would read 1,000 + 1 rows as whole and never read
    // the row the repeat displaced.
    const db = household(many(1001, single), 1000);
    const early = { from: (table: string) => {
      const b = db.from(table) as unknown as { range: (from: number, to: number) => unknown };
      const range = b.range.bind(b);
      b.range = (from: number, to: number) => range(from - 1, to);
      return b;
    } } as unknown as SupabaseClient<Database>;
    const res = await readCalendarOccurrences(early, FAMILY, WEEK, TZ);
    expect(res.data).toBeNull();
    expect(res.error?.message).toBe(`The database answered one-off event ${id(1000)} again on the page from row 1000, after an earlier page had returned it; the window cannot be read whole`);
  });

  it('fails closed when a page comes back empty short of the count, instead of answering a prefix', async () => {
    const db = household(many(1001, series), 1000);
    const empty = { from: (table: string) => {
      const b = db.from(table) as unknown as { range: (from: number, to: number) => unknown };
      const range = b.range.bind(b);
      b.range = (from: number, to: number) => range(from + 1_000_000, to + 1_000_000);
      return b;
    } } as unknown as SupabaseClient<Database>;
    const res = await readCalendarOccurrences(empty, FAMILY, WEEK, TZ);
    expect(res.data).toBeNull();
    expect(res.error?.message).toBe('The database answered 1000 of the 1001 recurring events it counted; the window cannot be read whole');
  });

  it('fails closed when the first answer is empty but counts rows', async () => {
    const db = household(many(3, series), 1000);
    const hollow = { from: (table: string) => {
      const b = db.from(table) as unknown as { then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => unknown };
      const then = b.then.bind(b);
      b.then = (resolve, reject) => then((v: unknown) => { const r = v as { count: number }; return resolve({ ...r, data: [], count: r.count }); }, reject);
      return b;
    } } as unknown as SupabaseClient<Database>;
    const res = await readCalendarOccurrences(hollow, FAMILY, WEEK, TZ);
    expect(res.data).toBeNull();
    expect(res.error?.message).toBe('The database answered 0 of the 3 recurring events it counted; the window cannot be read whole');
  });

  it('fails closed when the server answers more rows than it counted', async () => {
    const db = household(many(6, series), 1000);
    const undercounted = { from: (table: string) => {
      const b = db.from(table) as unknown as { then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => unknown };
      const then = b.then.bind(b);
      b.then = (resolve, reject) => then((v: unknown) => { const r = v as { count: number }; return resolve({ ...r, count: r.count > 0 ? r.count - 1 : r.count }); }, reject);
      return b;
    } } as unknown as SupabaseClient<Database>;
    const res = await readCalendarOccurrences(undercounted, FAMILY, WEEK, TZ);
    expect(res.data).toBeNull();
    expect(res.error?.message).toBe('The database answered 6 recurring events but counted 5; the window cannot be read whole');
  });

  it('asks both reads for an exact count, the first request unbounded, later pages by range in starts_at then id order', async () => {
    const db = household([...many(1001, series), ...many(3, single).map((r) => ({ ...r, id: id(5000 + Number(String(r.title).slice(6))) }))], 1000);
    type Call = { select?: unknown; range?: [number, number]; limit?: number; order: string[] };
    const calls: Call[] = [];
    const watched = { from: (table: string) => {
      const b = db.from(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
      const call: Call = { order: [] };
      calls.push(call);
      for (const name of ['select', 'range', 'limit', 'order'] as const) {
        const real = b[name].bind(b);
        b[name] = (...args: unknown[]) => {
          if (name === 'select') call.select = args[1];
          if (name === 'range') call.range = [args[0] as number, args[1] as number];
          if (name === 'limit') call.limit = args[0] as number;
          if (name === 'order') call.order.push(String(args[0]));
          return real(...args);
        };
      }
      return b;
    } } as unknown as SupabaseClient<Database>;
    const res = await readCalendarOccurrences(watched, FAMILY, WEEK, TZ);
    expect(res.error).toBeNull();
    expect(res.data?.map((r) => r.title)).toContain('Event 1001');
    // Two first requests (one-offs, series), then the series' second page.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.select).toEqual({ count: 'exact' });
      expect(call.order).toEqual(['starts_at', 'id']);
      expect(call.limit, 'no read is capped by a limit').toBeUndefined();
    }
    expect(calls.slice(0, 2).map((c) => c.range), 'the first request of each read is unbounded').toEqual([undefined, undefined]);
    expect(calls[2].range, 'the cut answer is read on from where it stopped').toEqual([1000, 1999]);
  });

  // Recheck 5981632558: a response with no count is not a whole answer, it is an
  // answer nobody can check. supabase-js reports a missing or unparsable
  // Content-Range as `count: null` with no error, and a cap of 500 under 1,001
  // rows then looked like 500 rows, complete.
  it.each([null, undefined, -1, 0.5, Number.NaN])('fails closed when the answer carries no usable count (%s)', async (count) => {
    const db = household(many(1001, series), 500);
    const uncounted = { from: (table: string) => {
      const b = db.from(table) as unknown as { then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => unknown };
      const then = b.then.bind(b);
      b.then = (resolve, reject) => then((v: unknown) => resolve({ ...(v as object), count }), reject);
      return b;
    } } as unknown as SupabaseClient<Database>;
    const res = await readCalendarOccurrences(uncounted, FAMILY, WEEK, TZ);
    expect(res.data).toBeNull();
    expect(res.count).toBeNull();
    // Both reads are refused; the one-off read's refusal is the one reported.
    expect(res.error?.message).toBe(`The database answered without a usable count of the one-off events (${String(count)}); the window cannot be read whole`);
  });

  it('fails closed when the count changes between pages, instead of skipping the rows that moved', async () => {
    // Page one: 1,500 series counted, 1,000 answered. Rows 1–499 are deleted
    // before page two, which is asked from offset 1,000 and so answers the one
    // row left past it, counting 1,001. 1,001 rows read against a count of
    // 1,001 looked complete while rows 1,001–1,499 were never read.
    const db = household(many(1500, series), 1000);
    let pages = 0;
    const shifting = { from: (table: string) => {
      const b = db.from(table) as unknown as { range: (from: number, to: number) => unknown };
      const range = b.range.bind(b);
      b.range = (from: number, to: number) => {
        if (pages++ === 0) db.replace('calendar_events', db.table('calendar_events').filter((row) => Number(String(row.id).slice(-12)) >= 500));
        return range(from, to);
      };
      return b;
    } } as unknown as SupabaseClient<Database>;
    const res = await readCalendarOccurrences(shifting, FAMILY, WEEK, TZ);
    expect(res.data).toBeNull();
    expect(res.error?.message).toBe('The count of recurring events changed from 1500 to 1001 while the window was being read; the window cannot be read whole');
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
