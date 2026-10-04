import { describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'synthetic-family';
const bounds = briefingCalendarBounds('2026-09-09', 'UTC', 0, 1);
const rows = (count: number, recurrence: 'none' | 'weekly') => Array.from({ length: count }, (_, index) => ({
  id: `event-${String(index).padStart(5, '0')}`, family_id: FAMILY,
  starts_at: recurrence === 'none' ? '2026-09-09T09:00:00.000Z' : '2026-09-02T09:00:00.000Z',
  ends_at: null, all_day: false, recurrence, recurrence_until: null,
}));

function client(recurrence: 'none' | 'weekly', count = 1001, maxRows = 1000) {
  const db = createInMemorySupabase({ maxRows });
  db.seed('calendar_events', rows(count, recurrence));
  return db as unknown as SupabaseClient<Database>;
}

describe('a calendar read is complete across response caps', () => {
  it.each(['none', 'weekly'] as const)('reads the 1001st %s event, including equal-start ties', async (recurrence) => {
    const result = await readCalendarOccurrences(client(recurrence), FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.error).toBeNull();
    expect(result.count).toBe(1001);
    expect(result.data?.at(-1)?.id).toBe('event-01000');
  });

  it('supports a lower cap without treating a short page as the end', async () => {
    const result = await readCalendarOccurrences(client('none', 1001, 500), FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.error).toBeNull();
    expect(result.count).toBe(1001);
  });

  it('applies the display limit after reading the complete count', async () => {
    const result = await readCalendarOccurrences(client('none'), FAMILY, bounds, 'UTC', { columns: ['id'], limit: 8 });
    expect(result.error).toBeNull();
    expect(result.count).toBe(1001);
    expect(result.data).toHaveLength(8);
  });

  it('refuses a series collection beyond the configured ceiling despite the response cap', async () => {
    const result = await readCalendarOccurrences(client('weekly', 2001), FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.data).toBeNull();
    expect(result.count).toBeNull();
    expect(result.error?.message).toContain('2000');
  });

  it('fails visibly at the one-off ceiling instead of returning its first page', async () => {
    const result = await readCalendarOccurrences(client('none', 20_001), FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.data).toBeNull();
    expect(result.count).toBeNull();
    expect(result.error?.message).toContain('20000');
  });
});

type Reply = { data: unknown; count?: unknown; error: { message: string } | null };
function scriptedClient(seriesReply: (offset: number) => Reply) {
  return { from: () => {
    let series = false;
    let offset = 0;
    const query: Record<string, unknown> = {};
    const chain = () => query;
    Object.assign(query, { select: chain, eq: chain, or: chain, lte: chain, order: chain, limit: chain,
      neq: () => { series = true; return query; },
      range: (from: number) => { offset = from; return query; },
      then: (resolve: (reply: Reply) => void) => resolve(series ? seriesReply(offset) : { data: [], count: 0, error: null }),
    });
    return query;
  } } as unknown as SupabaseClient<Database>;
}

describe('incomplete pages fail as unavailable calendars', () => {
  it.each([null, undefined, -1, 0.5, Number.NaN, '1'])('refuses an unusable exact count %s', async (count) => {
    const result = await readCalendarOccurrences(scriptedClient(() => ({ data: rows(1, 'weekly'), count, error: null })), FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.data).toBeNull();
    expect(result.count).toBeNull();
    expect(result.error?.message).toContain('count');
  });

  it('refuses a collection whose count changes between pages', async () => {
    const result = await readCalendarOccurrences(scriptedClient((offset) => ({
      data: offset === 0 ? rows(1000, 'weekly') : rows(1500, 'weekly').slice(1499), count: offset === 0 ? 1500 : 1001, error: null,
    })), FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain('changed from 1500 to 1001');
  });

  it('refuses a repeated page instead of merging a false complete count', async () => {
    const result = await readCalendarOccurrences(scriptedClient(() => ({ data: rows(1000, 'weekly'), count: 1500, error: null })), FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain('repeated');
  });

  it('refuses duplicate identities inside one page', async () => {
    const row = rows(1, 'weekly')[0];
    const result = await readCalendarOccurrences(scriptedClient(() => ({ data: [row, row], count: 2, error: null })), FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain('repeated');
  });

  it('refuses an empty or malformed page before reaching the count', async () => {
    for (const data of [null, {}]) {
      const result = await readCalendarOccurrences(scriptedClient(() => ({ data, count: 1, error: null })), FAMILY, bounds, 'UTC', { columns: ['id'] });
      expect(result.data).toBeNull();
      expect(result.error?.message).toContain('unavailable');
    }
    const result = await readCalendarOccurrences(scriptedClient((offset) => ({ data: offset === 0 ? rows(1, 'weekly') : [], count: 2, error: null })), FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain('stopped at 1 of 2');
  });

  it('refuses a page containing more rows than its exact count', async () => {
    const result = await readCalendarOccurrences(scriptedClient(() => ({ data: rows(2, 'weekly'), count: 1, error: null })), FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain('more rows');
  });

  it('drops the earlier page when a later database read fails', async () => {
    const result = await readCalendarOccurrences(scriptedClient((offset) => offset === 0
      ? { data: rows(1, 'weekly'), count: 2, error: null }
      : { data: null, count: null, error: { message: 'synthetic second-page failure' } }), FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.data).toBeNull();
    expect(result.count).toBeNull();
    expect(result.error?.message).toBe('synthetic second-page failure');
  });

  it('returns a transport rejection as an unavailable calendar', async () => {
    const result = await readCalendarOccurrences(scriptedClient(() => { throw new Error('synthetic transport failure'); }), FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.data).toBeNull();
    expect(result.count).toBeNull();
    expect(result.error?.message).toContain('synthetic transport failure');
  });
});

describe('the actual Supabase SDK against a synthetic capped REST response', () => {
  it.each(['none', 'weekly'] as const)('pages every %s row with exact counts and family scope', async (recurrence) => {
    const requests: URL[] = [];
    const db = createClient<Database>('https://synthetic-calendar.invalid', 'synthetic-test-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url);
        expect(url.searchParams.get('family_id')).toBe(`eq.${FAMILY}`);
        expect(url.searchParams.get('order')).toBe('starts_at.asc,id.asc');
        expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
        const wantsSeries = url.searchParams.get('recurrence') === 'neq.none';
        const collection = wantsSeries === (recurrence === 'weekly') ? rows(1001, recurrence) : [];
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const requested = Number(url.searchParams.get('limit') ?? collection.length);
        const page = collection.slice(offset, offset + Math.min(500, requested));
        return new Response(JSON.stringify(page), { status: 200, headers: {
          'content-type': 'application/json', 'content-range': `${offset}-${offset + Math.max(0, page.length - 1)}/${collection.length}`,
        } });
      } },
    });
    const result = await readCalendarOccurrences(db, FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.error).toBeNull();
    expect(result.count).toBe(1001);
    expect(result.data?.at(-1)?.id).toBe('event-01000');
    expect(requests.map((url) => Number(url.searchParams.get('offset') ?? 0)).sort((a, b) => a - b)).toEqual([0, 0, 500, 1000]);
  });

  it('treats a missing REST count header as a failed read', async () => {
    const db = createClient<Database>('https://synthetic-calendar.invalid', 'synthetic-test-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }) },
    });
    const result = await readCalendarOccurrences(db, FAMILY, bounds, 'UTC', { columns: ['id'] });
    expect(result.data).toBeNull();
    expect(result.count).toBeNull();
    expect(result.error?.message).toContain('count');
  });
});
