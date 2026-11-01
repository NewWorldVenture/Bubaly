// The nightly aggregation's first read — who consents — while families leave.
//
// N1-consent-read-offset-paging (round 5; pre-existing, reported by round 4's
// fixer). runNetworkAggregation read network_consent whole by paging with
// offset `.range()`. Past PostgREST's 1,000-row page that is two reads, and a
// family that left between them (enabled -> false, which the read filters
// out) moved every later row up one: the family sitting at the page boundary
// was in neither page. The run then PRUNED its stored contribution as if it
// had withdrawn, and left it out of the night's contributions — and of the
// epoch's snapshot, when that night published. The read now pages on the key,
// family_id past the last one read, so a write between pages cannot move a
// row past the cursor.
//
// The real run against the in-memory database at PostgREST's default 1,000
// rows a response; the only thing added is the leave, made by another request
// between the run's two consent pages.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { runNetworkAggregation } from '@/lib/network/aggregate-server';

type DB = SupabaseClient<Database>;

const NOW = new Date('2026-09-08T03:00:00Z');
const CAP = 1000;
const FAMILIES = Array.from({ length: CAP + 3 }, (_, i) => `fam-${String(i).padStart(4, '0')}`);
/** Leaves between the run's two consent pages, from the first of them. */
const LEAVER = FAMILIES[0];
/** First on the second page once the leave moved everyone up one. */
const AT_THE_BOUNDARY = FAMILIES[CAP];

let db: InMemorySupabase;
const stored = (familyId: string) => db.table('network_contributions').filter((r) => r.family_id === familyId);

/**
 * The run's client, through which another request's leave lands right after
 * the run's FIRST page of consenting families comes back.
 */
function leavingAfterTheFirstPage(): { client: DB; pages: () => number } {
  let pages = 0;
  const client = new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = (target as InMemorySupabase).from(table) as unknown as object;
        if (table !== 'network_consent') return builder;
        let selected = '';
        const wrapped: object = new Proxy(builder, {
          get(b, key) {
            if (key === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => (b as PromiseLike<unknown>).then((reply) => {
                // Step 1's read is the one that asks who wrote each consent.
                if (selected.includes('consented_by') && ++pages === 1) {
                  Object.assign(db.table('network_consent').find((r) => r.family_id === LEAVER)!, { enabled: false, scopes: {} });
                }
                return reply;
              }).then(resolve, reject);
            }
            const value = Reflect.get(b, key);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              if (key === 'select') selected = String(args[0]);
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
  db.seed('network_consent', FAMILIES.map((id) => ({ family_id: id, enabled: true, scopes: { benchmarks: true }, consented_by: null })));
  db.seed('family_members', FAMILIES.map((id) => ({
    id: `${id}-p`, family_id: id, user_id: `${id}-parent`, role: 'parent', birthday: '1985-03-03', is_active: true,
  })));
  // Every family already has the row an earlier night stored.
  db.seed('network_contributions', FAMILIES.map((id) => ({
    family_id: id, cohort_key: 'kids:none|size:1–2', features: {}, metrics: { dinner_habit: 'rarely (0–1)' }, scopes: { benchmarks: true },
  })));
});
afterEach(() => { vi.restoreAllMocks(); });

describe('step 1 reads every consenting family once, whoever leaves while it pages', () => {
  it('a leave between the two consent pages does not drop the family at the boundary', async () => {
    const { client, pages } = leavingAfterTheFirstPage();
    const result = await runNetworkAggregation(client, NOW);
    expect(pages()).toBeGreaterThan(1);   // the read really did page across the leave
    expect(result).toMatchObject({ ok: true, contributors: FAMILIES.length - 1 });
    // The family at the boundary still consents: its row is kept and refreshed …
    expect(stored(AT_THE_BOUNDARY)).toHaveLength(1);
    // (the seeded row has no `activities`; this night's rebuild does)
    expect(stored(AT_THE_BOUNDARY)[0].metrics).toHaveProperty('activities');
    // … the one that left is forgotten, and every other family is stored once.
    expect(stored(LEAVER)).toEqual([]);
    const ids = db.table('network_contributions').map((r) => r.family_id as string);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(FAMILIES.slice(1));
  });

  it('control: with nobody leaving, every family is read and stored', async () => {
    expect(await runNetworkAggregation(db as unknown as DB, NOW)).toMatchObject({ ok: true, contributors: FAMILIES.length });
    expect(db.table('network_contributions')).toHaveLength(FAMILIES.length);
  });
});
