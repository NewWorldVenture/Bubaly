// Two aggregation runs side by side still publish one sample per band per
// epoch, and never take the held snapshot away.
//
// N11-hold-overlap-wipe (round 3). The hold re-stamped this epoch's rows to the
// run's own `now`, and the publish's prune then deleted every row stamped
// before that `now`. Two runs can overlap: vercel.json and
// scripts/cron-dispatch.mjs can both call the route at 03:00, and a cron event
// can be delivered twice. When the later-started run held first and the earlier
// one re-stamped every row back to its own, earlier, `now`, the later run's
// prune deleted the whole snapshot. Both runs answered ok and held; the public
// page and the digest went empty, and the next night found nothing to hold and
// published the epoch AGAIN, from a changed state. Two first runs of an epoch
// did the same harm another way: both found nothing to hold, both published,
// and the second publish overwrote the first's figures inside one epoch.
//
// Now one run at a time holds or publishes (a claim in app_settings), a run
// that finds the claim taken leaves the figures to its holder, and the prune
// reaches only earlier epochs' rows. Pruning by the epoch alone closes the
// first race and not the second: two first runs still each publish.
//
// The runs below are real runNetworkAggregation calls against the in-memory
// database; one of them is paused on a network_aggregates statement while the
// other runs, which is exactly the interleaving the cron can produce.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { runNetworkAggregation } from '@/lib/network/aggregate-server';

type DB = SupabaseClient<Database>;

const AUGUST = new Date('2026-08-31T03:00:00Z');
const SEPTEMBER = new Date('2026-09-08T03:00:00Z');
const SEPTEMBER_STARTS = '2026-09-01T00:00:00.000Z';
const night = (n: number, from = SEPTEMBER) => new Date(from.getTime() + n * 86_400_000);
const second = (at: Date, s: number) => new Date(at.getTime() + s * 1000);

let db: InMemorySupabase;

function household(id: string, opts: { kid?: boolean } = {}) {
  db.seed('families', [{ id, closed_at: null, timezone: 'UTC' }]);
  db.seed('network_consent', [{ family_id: id, enabled: true, scopes: { benchmarks: true }, consented_by: null }]);
  db.seed('family_members', [
    { id: `${id}-p`, family_id: id, user_id: `${id}-parent`, role: 'parent', birthday: '1985-03-03', is_active: true },
    ...(opts.kid === false ? [] : [{ id: `${id}-k`, family_id: id, user_id: null, role: 'child', birthday: '2018-06-01', is_active: true }]),
  ]);
}

/** Every published cell → its noised count and true size, as a reader would take them. */
const published = (since = '') => new Map(db.table('network_aggregates')
  .filter((r) => String(r.computed_at) >= since)
  .map((r) => [`${r.cohort_key}|${r.metric}|${r.value}`, `${r.count}/${r.cohort_size}`]));

/**
 * The database as one run sees it, with that run's first network_aggregates
 * statement of `kind` paused: `reached` settles when the run gets there, and
 * the statement goes to the database only once `release()` is called.
 */
function pausedAt(kind: 'update' | 'upsert' | 'delete'): { client: DB; reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  let paused = false;
  const client = new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = (target as InMemorySupabase).from(table) as unknown as object;
        if (table !== 'network_aggregates') return builder;
        let isKind = false;
        const wrapped: object = new Proxy(builder, {
          get(b, key) {
            const value = Reflect.get(b, key);
            if (key === 'then' && typeof value === 'function') {
              const then = (value as (...a: unknown[]) => unknown).bind(b);
              if (!isKind || paused) return then;
              paused = true;
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
                arrive();
                return gate.then(() => then(resolve, reject));
              };
            }
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              if (key === kind) isKind = true;
              const out = (value as (...a: unknown[]) => unknown).apply(b, args);
              return out === b ? wrapped : out;
            };
          },
        });
        return wrapped;
      };
    },
  }) as unknown as DB;
  return { client, reached, release };
}

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { network_contributions: [['family_id']], network_aggregates: [['scope', 'cohort_key', 'metric', 'value']], app_settings: [['key']] },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (let i = 0; i < 120; i++) household(`f-${i}`);
  for (let i = 0; i < 25; i++) household(`nokid-${i}`, { kid: false });
});
afterEach(() => vi.restoreAllMocks());

describe('two runs inside one epoch (N11-hold-overlap-wipe)', () => {
  it('a later-started run that holds first is not left to delete the snapshot an earlier run re-stamped', async () => {
    expect(await runNetworkAggregation(db as unknown as DB, SEPTEMBER)).toMatchObject({ ok: true, held: false });
    const snapshot = published();
    expect(snapshot.size).toBeGreaterThanOrEqual(6);
    // The state moves inside the epoch, so a second publish would differ.
    household('joiner-1'); household('joiner-2'); household('joiner-3');
    expect(await runNetworkAggregation(db as unknown as DB, night(3))).toMatchObject({ ok: true, held: true });

    // Night 4: run B, started a second after run A, reaches the hold first and
    // is paused at its prune; run A runs to the end meanwhile.
    const b = pausedAt('delete');
    const runB = runNetworkAggregation(b.client, second(night(4), 1));
    await b.reached;
    const runA = await runNetworkAggregation(db as unknown as DB, night(4));
    expect(runA.ok).toBe(true);
    expect(published()).toEqual(snapshot);
    b.release();
    expect(await runB).toMatchObject({ ok: true, epoch: '2026-09', held: true });

    // The snapshot is still there for every reader …
    expect(published()).toEqual(snapshot);
    // … and the nights after hold it: no second sample of the epoch.
    for (const n of [5, 6]) {
      expect(await runNetworkAggregation(db as unknown as DB, night(n)), `night ${n}`).toMatchObject({ ok: true, held: true, aggregates: snapshot.size });
      expect(published(), `night ${n}`).toEqual(snapshot);
    }
  });

  it('two first runs of an epoch publish it once, though the state moved between them', async () => {
    // August's figures are standing, as they are on the first night of September.
    expect(await runNetworkAggregation(db as unknown as DB, AUGUST)).toMatchObject({ ok: true, epoch: '2026-08', held: false });

    // Run A finds nothing of September to hold, aggregates, and is paused at
    // its publish. Three households join; run B, a second later, reads them.
    const a = pausedAt('upsert');
    const runA = runNetworkAggregation(a.client, night(1, AUGUST));
    await a.reached;
    household('joiner-1'); household('joiner-2'); household('joiner-3');
    const runB = await runNetworkAggregation(db as unknown as DB, second(night(1, AUGUST), 1));
    expect(runB.ok).toBe(true);
    // What a reader sees of September at this moment, and after each run.
    const seen = new Map<string, Set<string>>();
    const look = () => { for (const [cell, figure] of published(SEPTEMBER_STARTS)) seen.set(cell, (seen.get(cell) ?? new Set()).add(figure)); };
    look();
    a.release();
    expect(await runA).toMatchObject({ ok: true, epoch: '2026-09', held: false });
    look();
    const september = published();
    expect(september.size).toBeGreaterThanOrEqual(6);
    // Every row standing is September's: August's leftovers went with the publish.
    expect(db.table('network_aggregates').every((r) => String(r.computed_at) >= SEPTEMBER_STARTS)).toBe(true);

    for (const n of [2, 3]) {
      expect(await runNetworkAggregation(db as unknown as DB, night(n, AUGUST)), `night ${n}`).toMatchObject({ ok: true, epoch: '2026-09', held: true });
      look();
      expect(published(), `night ${n}`).toEqual(september);
    }
    // One figure per band for the whole epoch: never one sample, then another.
    const twice = [...seen].filter(([, figures]) => figures.size > 1).map(([cell, figures]) => `${cell}: ${[...figures].join(' then ')}`);
    expect(twice).toEqual([]);
  });

  it('a run that finds the publication taken leaves the figures to that run, and still refreshes its contributions', async () => {
    expect(await runNetworkAggregation(db as unknown as DB, SEPTEMBER)).toMatchObject({ ok: true, held: false });
    const snapshot = published();
    db.replace('network_consent', db.table('network_consent').filter((r) => r.family_id !== 'f-0'));

    const first = pausedAt('update');
    const holding = runNetworkAggregation(first.client, night(1));
    await first.reached;
    const beside = await runNetworkAggregation(db as unknown as DB, second(night(1), 30));
    expect(beside).toMatchObject({ ok: true, contributors: 144, aggregates: 0, deferred: true });
    // The withdrawn family is forgotten by both runs, whichever publishes.
    expect(db.table('network_contributions').some((r) => r.family_id === 'f-0')).toBe(false);
    first.release();
    expect(await holding).toMatchObject({ ok: true, held: true, aggregates: snapshot.size });
    expect(published()).toEqual(snapshot);
    expect(db.table('network_aggregates').every((r) => r.computed_at === night(1).toISOString())).toBe(true);
  });

  it('gives the publication back when it ends, even when its publish fails', async () => {
    const failing = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = (target as InMemorySupabase).from(table) as unknown as Record<string, unknown>;
          if (table !== 'network_aggregates') return builder;
          return new Proxy(builder, {
            get(b, key) {
              if (key === 'upsert') return () => Promise.resolve({ data: null, error: { message: 'connection reset' } });
              const value = Reflect.get(b, key);
              return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(b) : value;
            },
          });
        };
      },
    }) as unknown as DB;
    expect(await runNetworkAggregation(failing, SEPTEMBER)).toMatchObject({ ok: false });
    expect(db.table('network_aggregates')).toEqual([]);
    // A minute later, well inside the claim's lifetime: not held by the failed run.
    const retry = await runNetworkAggregation(db as unknown as DB, new Date(SEPTEMBER.getTime() + 60_000));
    expect(retry).toMatchObject({ ok: true, epoch: '2026-09', held: false });
    expect(retry.deferred).toBeUndefined();
    expect(published().size).toBeGreaterThanOrEqual(6);
  });

  it('a run that cannot read or write the claim publishes nothing, after forgetting the withdrawn, and says so', async () => {
    expect(await runNetworkAggregation(db as unknown as DB, SEPTEMBER)).toMatchObject({ ok: true, held: false });
    const snapshot = published();
    db.replace('network_consent', db.table('network_consent').filter((r) => r.family_id !== 'f-0'));
    const refused = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          if (table !== 'app_settings') return (target as InMemorySupabase).from(table);
          const chain: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'insert', 'update']) chain[m] = () => chain;
          chain.maybeSingle = () => Promise.resolve({ data: null, error: { message: 'connection reset' } });
          return chain;
        };
      },
    }) as unknown as DB;
    const result = await runNetworkAggregation(refused, night(1));
    expect(result).toMatchObject({ ok: false, error: 'failed to claim the publication', aggregates: 0 });
    expect(db.table('network_contributions').some((r) => r.family_id === 'f-0')).toBe(false);
    // Not re-stamped and not changed: the figures stand as the last run left them.
    expect(published()).toEqual(snapshot);
    expect(db.table('network_aggregates').every((r) => r.computed_at === SEPTEMBER.toISOString())).toBe(true);
  });
});
