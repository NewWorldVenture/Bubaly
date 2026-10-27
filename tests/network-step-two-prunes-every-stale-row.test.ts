// The nightly aggregation's prune — which stored rows are stale — while rows
// leave the table it reads.
//
// N1-consent-read-offset-paging/step-two-prune-read-still-offset (round 6).
// Step 1's consent read pages on the key since round 5; step 2's read of the
// STORED contributions, the prune's input, still paged by offset. Past
// PostgREST's 1,000-row page that is two reads of a table rows leave while it
// is read: a family's leave deletes its row (withdrawal-server.ts), and so
// does an overlapping run's re-check. Such a delete between the two pages
// moved every later row up one, and the row at the boundary was in neither
// page. When that row was stale (a family out of the network whose row was
// still stored: its leave's delete failed, or one of the two cases
// withdrawal-server.ts names), the run reported ok and kept it for another
// night, though the design doc (§2.7), the withdrawal-server.ts header and
// the forget_failed outcome all say the next night's run prunes it. The read
// now pages on family_id past the last one read.
//
// The real run against the in-memory database at PostgREST's default 1,000
// rows a response; the only thing added is the leave, made by another request
// between the prune read's two pages.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { runNetworkAggregation } from '@/lib/network/aggregate-server';

type DB = SupabaseClient<Database>;

const NOW = new Date('2026-09-08T03:00:00Z');
const CAP = 1000;
const FAMILIES = Array.from({ length: CAP + 3 }, (_, i) => `fam-${String(i).padStart(4, '0')}`);
/** Leaves between the prune read's two pages; its row is on the first. */
const LEAVER = FAMILIES[0];
/**
 * Out of the network, its row still stored: the prune's to delete. First on
 * the second page, so the leave's delete moves it onto the first, already read.
 */
const STALE = FAMILIES[CAP];

let db: InMemorySupabase;
const stored = (familyId: string) => db.table('network_contributions').filter((r) => r.family_id === familyId);

/**
 * The run's client, through which another request's leave lands right after
 * the FIRST page of the run's read of the stored contributions comes back.
 * That read is the only one the run makes of network_contributions; its
 * deletes and upserts are writes, and are not counted.
 */
function leavingAfterTheFirstStoredPage(): { client: DB; pages: () => number } {
  let pages = 0;
  const client = new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = (target as InMemorySupabase).from(table) as unknown as object;
        if (table !== 'network_contributions') return builder;
        let isRead = true;
        const wrapped: object = new Proxy(builder, {
          get(b, key) {
            if (key === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => (b as PromiseLike<unknown>).then((reply) => {
                if (isRead && ++pages === 1) {
                  // withdrawFromNetwork's two writes: consent off, then the row.
                  Object.assign(db.table('network_consent').find((r) => r.family_id === LEAVER)!, { enabled: false, scopes: {} });
                  db.replace('network_contributions', db.table('network_contributions').filter((r) => r.family_id !== LEAVER));
                }
                return reply;
              }).then(resolve, reject);
            }
            const value = Reflect.get(b, key);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              if (['insert', 'upsert', 'update', 'delete'].includes(String(key))) isRead = false;
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

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    maxRows: CAP,
    uniques: { network_contributions: [['family_id']], network_aggregates: [['scope', 'cohort_key', 'metric', 'value']], app_settings: [['key']] },
  });
  db.seed('families', FAMILIES.map((id) => ({ id, closed_at: null, timezone: 'UTC' })));
  db.seed('network_consent', FAMILIES.map((id) => ({
    family_id: id, enabled: id !== STALE, scopes: id === STALE ? {} : { benchmarks: true }, consented_by: null,
  })));
  db.seed('family_members', FAMILIES.map((id) => ({
    id: `${id}-p`, family_id: id, user_id: `${id}-parent`, role: 'parent', birthday: '1985-03-03', is_active: true,
  })));
  // Every family has the row an earlier night stored, STALE's included.
  db.seed('network_contributions', FAMILIES.map((id) => ({
    family_id: id, cohort_key: 'kids:none|size:1–2', features: {}, metrics: { dinner_habit: 'rarely (0–1)' }, scopes: { benchmarks: true },
  })));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('step 2 prunes every stale row, whoever leaves while it pages', () => {
  it('a leave between the prune read\'s two pages does not keep the stale row at the boundary', async () => {
    const { client, pages } = leavingAfterTheFirstStoredPage();
    const result = await runNetworkAggregation(client, NOW);
    expect(pages()).toBeGreaterThan(1);   // the read really did page across the leave
    expect(result).toMatchObject({ ok: true, contributors: FAMILIES.length - 2 });
    // The family out of the network is pruned the night it was promised …
    expect(stored(STALE)).toEqual([]);
    // … the one that left during the run is forgotten (the re-check deletes
    // the row this run's upsert wrote back), and every other family is
    // stored once.
    expect(stored(LEAVER)).toEqual([]);
    const ids = db.table('network_contributions').map((r) => r.family_id as string);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(FAMILIES.filter((id) => id !== LEAVER && id !== STALE));
  });

  it('control: with nobody leaving, the stale row is pruned and every other family kept', async () => {
    expect(await runNetworkAggregation(db as unknown as DB, NOW)).toMatchObject({ ok: true, contributors: FAMILIES.length - 1 });
    expect(stored(STALE)).toEqual([]);
    expect(db.table('network_contributions')).toHaveLength(FAMILIES.length - 1);
  });
});
