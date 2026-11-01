// The benchmark report's read of the published figures, while the aggregation
// rewrites them.
//
// Round 6, the sibling of N1-consent-read-offset-paging/step-two-prune-read-
// still-offset: readBenchmarkAggregates (the public page, the CSV export and
// the admin report) read network_aggregates whole by offset pages over
// (cohort_size desc, cohort_key, metric, value, id). That order is total, but
// past PostgREST's 1,000-row page the read is two reads of a table the
// aggregation writes while it is read: an epoch's publish upserts every band
// in place, so a band whose cohort_size changed moves to another position, and
// then prunes the earlier epoch's rows. A prune between the two pages moved
// every later band up one, and the band at the boundary was in neither page;
// a band rewritten ahead of the boundary left the second page one band early,
// which it read twice, and was itself never read. The read now pages on id
// past the last one read, and an id does not move.
//
// The real helper against the in-memory database at PostgREST's default 1,000
// rows a response. 1,003 bands, numbered so that the old order and id order
// agree: band i has id agg-i and the i-th largest cohort.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// The helper's own client factory is never used here: the read is handed the
// in-memory database.
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => { throw new Error('not in this test'); } }));
const { readBenchmarkAggregates } = await import('@/lib/network/benchmarks-server');

type DB = SupabaseClient<Database>;

const NOW = new Date('2026-09-01T03:00:30Z');
const CAP = 1000;
const BANDS = CAP + 3;
const aggId = (i: number) => `agg-${String(i).padStart(4, '0')}`;
const keyOf = (i: number) => `kids:none|size:1–2|dinner_habit|band-${String(i).padStart(4, '0')}`;

let db: InMemorySupabase;

/**
 * The reader's client, through which the aggregation's write lands right
 * after the FIRST page of the read comes back.
 */
function writingAfterTheFirstPage(write: () => void): { client: DB; pages: () => number } {
  let pages = 0;
  const client = new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = (target as InMemorySupabase).from(table) as unknown as object;
        if (table !== 'network_aggregates') return builder;
        const wrapped: object = new Proxy(builder, {
          get(b, key) {
            if (key === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => (b as PromiseLike<unknown>).then((reply) => {
                if (++pages === 1) write();
                return reply;
              }).then(resolve, reject);
            }
            const value = Reflect.get(b, key);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              const out = Reflect.apply(value, b, args);
              return out === b ? wrapped : out;
            };
          },
        });
        return wrapped;
      };
    },
  }) as unknown as DB;
  return { client, pages: () => pages };
}

/** How many times the read returned each band. */
async function timesRead(client: DB): Promise<Map<string, number>> {
  const read = await readBenchmarkAggregates(client, NOW);
  if (!read.ok) throw new Error('the read failed');
  const times = new Map<string, number>();
  for (const a of read.aggregates) {
    const key = `${a.cohortKey}|${a.metric}|${a.value}`;
    times.set(key, (times.get(key) ?? 0) + 1);
  }
  return times;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: CAP });
  db.seed('network_aggregates', Array.from({ length: BANDS }, (_, i) => ({
    id: aggId(i), scope: 'benchmarks', cohort_key: 'kids:none|size:1–2', metric: 'dinner_habit',
    value: `band-${String(i).padStart(4, '0')}`, count: 25, cohort_size: 5000 - i, computed_at: '2026-08-31T03:00:00.000Z',
  })));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the benchmark read reads each band once, whatever the aggregation writes while it pages', () => {
  it('a prune between the read\'s pages does not drop the band at the boundary', async () => {
    const { client, pages } = writingAfterTheFirstPage(() => {
      // The epoch's publish prunes an earlier epoch's band from the first page.
      db.replace('network_aggregates', db.table('network_aggregates').filter((r) => r.id !== aggId(0)));
    });
    const times = await timesRead(client);
    expect(pages()).toBeGreaterThan(1);   // the read really did page across the prune
    // Every band present for the whole read, once each.
    for (let i = 1; i < BANDS; i++) expect(times.get(keyOf(i)), keyOf(i)).toBe(1);
  });

  it('a band rewritten between the read\'s pages is read once, and so is every other', async () => {
    const { client, pages } = writingAfterTheFirstPage(() => {
      // The publish's upsert, in place: a band of the second page grows past every other.
      Object.assign(db.table('network_aggregates').find((r) => r.id === aggId(CAP + 1))!, {
        count: 31, cohort_size: 9999, computed_at: NOW.toISOString(),
      });
    });
    const times = await timesRead(client);
    expect(pages()).toBeGreaterThan(1);
    for (let i = 0; i < BANDS; i++) expect(times.get(keyOf(i)), keyOf(i)).toBe(1);
  });

  it('control: with nothing written meanwhile, every band is read once', async () => {
    const times = await timesRead(db as unknown as DB);
    expect(times.size).toBe(BANDS);
    expect([...times.values()].every((n) => n === 1)).toBe(true);
  });
});
