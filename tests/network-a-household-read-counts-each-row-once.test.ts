// The nightly aggregation's household reads, while households write to them.
//
// Round 6, the sibling of N1-consent-read-offset-paging/step-two-prune-read-
// still-offset: the nine source reads that build each family's bands are
// chunked a hundred families at a time and paged inside each chunk, and the
// pages were offsets. A hundred households' transactions over four weeks run
// past PostgREST's 1,000-row page, so one chunk's spend is two reads of a
// table families write to at any hour. One household deleting an expense
// between the two pages moved every later row up one, and the row at the
// boundary, another household's, was in neither page: that household was
// banded on a sum without it. One adding an expense ahead of the next offset
// pushed the boundary row onto the second page as well, and it was summed
// twice. The reads now page on id past the last one read
// (readAllByIdInChunks).
//
// The real run against the in-memory database at PostgREST's default 1,000
// rows a response. Two households share a chunk: BUSY has a thousand small
// expenses, QUIET one of 600, which is 150 a week, the band '100–250'. The
// ids put QUIET's expense at the page boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { runNetworkAggregation } from '@/lib/network/aggregate-server';

type DB = SupabaseClient<Database>;

const NOW = new Date('2026-09-08T03:00:00Z');
const CAP = 1000;
const BUSY = 'fam-busy';
const QUIET = 'fam-quiet';
const txId = (n: number) => `tx-${String(n).padStart(4, '0')}`;
/** QUIET's one expense of the four weeks, after every one of BUSY's in id order. */
const QUIET_EXPENSE = txId(CAP);

let db: InMemorySupabase;
const spendBand = (familyId: string) => (db.table('network_contributions')
  .find((r) => r.family_id === familyId)?.metrics as Record<string, string> | undefined)?.weekly_spend_band;

const expense = (id: string, familyId: string, amount: number) => ({ id, family_id: familyId, type: 'expense', amount, date: '2026-09-01' });

/**
 * The run's client, through which another request writes to transactions
 * right after the FIRST page of the run's spend read comes back.
 */
function writingAfterTheFirstSpendPage(write: () => void): { client: DB; pages: () => number } {
  let pages = 0;
  const client = new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = (target as InMemorySupabase).from(table) as unknown as object;
        if (table !== 'transactions') return builder;
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

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    maxRows: CAP,
    uniques: { network_contributions: [['family_id']], network_aggregates: [['scope', 'cohort_key', 'metric', 'value']], app_settings: [['key']] },
  });
  for (const id of [BUSY, QUIET]) {
    db.seed('families', [{ id, closed_at: null, timezone: 'UTC' }]);
    db.seed('network_consent', [{ family_id: id, enabled: true, scopes: { benchmarks: true }, consented_by: null }]);
    db.seed('family_members', [{ id: `${id}-p`, family_id: id, user_id: `${id}-parent`, role: 'parent', birthday: '1985-03-03', is_active: true }]);
  }
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a household read counts each row once, whoever writes while it pages', () => {
  it('an expense deleted between the spend read\'s pages does not drop another household\'s from its sum', async () => {
    // BUSY's thousand fill the first page exactly; QUIET's is the first of the second.
    db.seed('transactions', [...Array.from({ length: CAP }, (_, i) => expense(txId(i), BUSY, 1)), expense(QUIET_EXPENSE, QUIET, 600)]);
    const { client, pages } = writingAfterTheFirstSpendPage(() => {
      db.replace('transactions', db.table('transactions').filter((r) => r.id !== txId(0)));
    });
    expect(await runNetworkAggregation(client, NOW)).toMatchObject({ ok: true, contributors: 2 });
    expect(pages()).toBeGreaterThan(1);   // the read really did page across the delete
    expect(spendBand(QUIET)).toBe('100–250');
  });

  it('an expense added between the spend read\'s pages does not count another household\'s twice', async () => {
    // BUSY's 999 and QUIET's fill the first page; QUIET's is its last row.
    db.seed('transactions', [...Array.from({ length: CAP - 1 }, (_, i) => expense(txId(i + 1), BUSY, 1)), expense(QUIET_EXPENSE, QUIET, 600)]);
    const { client, pages } = writingAfterTheFirstSpendPage(() => {
      // A new expense whose id sorts first, as half of all random uuids do.
      db.seed('transactions', [expense(txId(0), BUSY, 1)]);
    });
    expect(await runNetworkAggregation(client, NOW)).toMatchObject({ ok: true, contributors: 2 });
    expect(pages()).toBeGreaterThan(1);
    // Summed twice, 1,200 is 300 a week: '250–500'.
    expect(spendBand(QUIET)).toBe('100–250');
  });

  it('control: with nobody writing, the household is banded on its one expense', async () => {
    db.seed('transactions', [...Array.from({ length: CAP }, (_, i) => expense(txId(i), BUSY, 1)), expense(QUIET_EXPENSE, QUIET, 600)]);
    expect(await runNetworkAggregation(db as unknown as DB, NOW)).toMatchObject({ ok: true, contributors: 2 });
    expect(spendBand(QUIET)).toBe('100–250');
    // 1,000 over four weeks is 250 a week.
    expect(spendBand(BUSY)).toBe('250–500');
  });
});
