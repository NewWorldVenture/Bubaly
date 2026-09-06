// The recap's correctness rests on one filter, and nothing asserted it.
//
// `loadOperatingIndex` computes TODAY's index live and diffs it against the most
// recent snapshot STRICTLY BEFORE today (`.lt('as_of_date', today)`). Every
// surface that shows "Since yesterday" — the Operating Index page, the Command
// Center, the Daily Briefing — inherits that anchor.
//
// Drop it, or replace it with "the two most recent rows", and the diff silently
// becomes yesterday-vs-the-day-before whenever today's row does not exist yet.
// That is not hypothetical: `family_operating_index` is written LAZILY, by this
// function's own upsert, so on a morning when nobody has opened one of those
// pages there IS no row for today. The card still renders, still says "Since
// yesterday", and is a day out of date with nothing to say so.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { asOfDate, loadOperatingIndex } from '@/lib/operating-index/server';

type Call = { table: string; kind: 'select' | 'upsert'; filters: Record<string, unknown> };

/**
 * Enough PostgREST to let the whole snapshot build run against empty tables.
 * Every read answers `[]`, which is a real state (a brand-new family) rather
 * than a contrivance, so the index still computes and the prior read still runs.
 */
function makeDb() {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    const reply = { data: [], error: null };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, in: chain, is: chain, or: chain, ilike: chain, not: chain,
      eq: filter, neq: filter,
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      gt: (c: string, v: unknown) => filter(`gt:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      upsert: () => { call.kind = 'upsert'; return b; },
      single: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (value: typeof reply) => void) => resolve(reply),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-06T07:10:00Z');

describe('the operating index anchors its recap to today', () => {
  it('reads the prior snapshot from strictly BEFORE today, not just the newest rows', async () => {
    const { db, calls } = makeDb();
    await loadOperatingIndex(db, 'fam-1', NOW);

    const snapshotReads = calls.filter((c) => c.table === 'family_operating_index' && c.kind === 'select');
    expect(snapshotReads.length, 'the prior-snapshot read disappeared').toBeGreaterThan(0);

    const anchored = snapshotReads.find((c) => c.filters['lt:as_of_date'] === asOfDate(NOW));
    expect(
      anchored,
      'no read anchored with .lt("as_of_date", today) — the recap can now diff two arbitrary days',
    ).toBeTruthy();
    expect(anchored?.filters.family_id).toBe('fam-1');
  });

  it('persists today under today, so the next reader has something to diff against', async () => {
    // The upsert is why a morning visit fixes the staleness for every other
    // surface rather than only for the page that triggered it.
    const { db, calls } = makeDb();
    await loadOperatingIndex(db, 'fam-1', NOW);
    expect(calls.some((c) => c.table === 'family_operating_index' && c.kind === 'upsert')).toBe(true);
  });

  it('asOfDate is a calendar day, which is what the column stores', () => {
    expect(asOfDate(NOW)).toBe('2026-09-06');
    expect(asOfDate(new Date('2026-01-01T23:59:59Z'))).toBe('2026-01-01');
  });
});
