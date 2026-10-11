// The document-expiry reminder window is bounded by the FAMILY's day.
//
// `documents.expires_at` is a DATE. The query used to bound it with UTC
// instants (`now` and `now + 14d`), which Postgres reads as UTC dates. At
// 18:00 on 9 October in Los Angeles it is already 10 October at Greenwich, so
// a passport expiring on the 9th (today, for the family) was excluded and never
// announced; in Tokyo, yesterday's expiry was still called "expiring".
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { generateFamilyNotifications } from '@/lib/server/notifications';

type Filters = Record<string, unknown>;

function fakeSupabase(timezone: string) {
  const documentFilters: Filters[] = [];
  const from = (table: string) => {
    const filters: Filters = {};
    if (table === 'documents') documentFilters.push(filters);
    const result = table === 'families' ? { data: { timezone }, error: null } : { data: [], error: null };
    const record = (op: string) => (column: string, value: unknown) => { filters[`${op}:${column}`] = value; return c; };
    const c: Record<string, unknown> = {
      select: () => c, eq: record('eq'), neq: () => c, gte: record('gte'), lte: record('lte'), in: () => c,
      is: () => c, not: () => c, or: () => c, ilike: () => c, order: () => c, limit: () => c, range: () => c,
      maybeSingle: () => Promise.resolve(result),
      insert: () => Promise.resolve({ data: null, error: null }),
      then: (onF: (v: unknown) => unknown) => Promise.resolve(Array.isArray(result.data) ? { ...result, count: result.data.length } : result).then(onF),
    };
    return c;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, documentFilters };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('document expiry window', () => {
  it.each([
    // 18:00 on 9 October in Los Angeles = 01:00Z on the 10th.
    ['America/Los_Angeles', '2026-10-10T01:00:00Z', '2026-10-09', '2026-10-23'],
    // 08:00 on 10 October in Tokyo = 23:00Z on the 9th.
    ['Asia/Tokyo', '2026-10-09T23:00:00Z', '2026-10-10', '2026-10-24'],
    ['UTC', '2026-10-10T12:00:00Z', '2026-10-10', '2026-10-24'],
  ])('in %s at %s, spans the family days %s..%s', async (tz, instant, from, to) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instant));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, documentFilters } = fakeSupabase(tz);
    await generateFamilyNotifications(db, 'fam-1');
    expect(documentFilters).toHaveLength(1);
    expect(documentFilters[0]).toMatchObject({ 'eq:family_id': 'fam-1', 'gte:expires_at': from, 'lte:expires_at': to });
  });
});
