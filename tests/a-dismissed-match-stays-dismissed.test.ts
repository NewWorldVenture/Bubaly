import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * A dismissed match stays dismissed when the browse page snapshots the
 * family's matches (MT-0).
 *
 * loadAndSnapshotMatches (lib/marketplace/matches-server.ts, run by
 * /marketplace/browse) read every match's status, skipped the dismissed and
 * actioned ones, and upserted the rest with `status: 'active'`. ON CONFLICT
 * DO UPDATE rewrites every column the row carries, so a dismissal that
 * another member, or the same member in another tab, committed between that
 * read and the upsert was turned back to active. Two deterministic routes led
 * to the same place: the status read's error was never checked (a failed read
 * left nothing to skip), and it was not paged (past db-max-rows the skipped
 * set was a sample). The row now carries no status: a new match takes the
 * column default, 'active', and an existing one keeps whatever it has.
 */
const { loadAndSnapshotMatches } = await import('@/lib/marketplace/matches-server');

const FAMILY = 'fam-1';
let db: InMemorySupabase;

const listing = (over: Row): Row => ({
  family_id: FAMILY, category: 'sports', status: 'available', price_cents: 0, ...over,
});

function seedBoard() {
  db.seed('family_members', [
    { id: 'm-ana', family_id: FAMILY, display_name: 'Ana' },
    { id: 'm-ben', family_id: FAMILY, display_name: 'Ben' },
  ]);
  db.seed('marketplace_listings', [
    listing({ id: 'l-want', kind: 'wanted', title: 'Kids bike', member_id: 'm-ana' }),
    listing({ id: 'l-have', kind: 'free', title: 'Kids bike, blue', member_id: 'm-ben' }),
  ]);
}

const theMatch = () => db.table('marketplace_matches').find((m) => m.wanted_id === 'l-want' && m.supply_id === 'l-have');

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { marketplace_matches: [['family_id', 'wanted_id', 'supply_id']] },
    // 0150: `status text not null default 'active'`.
    defaults: { marketplace_matches: { status: 'active' } },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  seedBoard();
});

describe('the browse page\'s match snapshot', () => {
  it('records a new match as active and shows it', async () => {
    const shown = await loadAndSnapshotMatches(db as never, FAMILY, 'user-ana');
    expect(shown.map((m) => m.supplyId)).toEqual(['l-have']);
    expect(theMatch()).toMatchObject({ status: 'active', created_by: 'user-ana' });
  });

  it('keeps a dismissal committed between its status read and its upsert', async () => {
    db.seed('marketplace_matches', [{ id: 'mt-1', family_id: FAMILY, wanted_id: 'l-want', supply_id: 'l-have', score: 10, reason: null, status: 'active' }]);
    // Ben dismisses the match from another tab the moment after the snapshot
    // has read the statuses (setMatchStatusAction is family-wide, 0150).
    const realFrom = db.from.bind(db);
    let reads = 0;
    (db as unknown as { from: (table: string) => object }).from = (table: string) => {
      const builder = realFrom(table);
      if (table !== 'marketplace_matches') return builder;
      const select = builder.select.bind(builder);
      builder.select = ((...args: Parameters<typeof select>) => {
        reads += 1;
        if (reads === 1) {
          const then = builder.then.bind(builder);
          (builder as { then: typeof builder.then }).then = ((ok, bad) => then((reply) => {
            theMatch()!.status = 'dismissed';
            return reply;
          }).then(ok, bad)) as typeof builder.then;
        }
        return select(...args);
      }) as typeof builder.select;
      return builder;
    };

    const shown = await loadAndSnapshotMatches(db as never, FAMILY, 'user-ana');

    expect(theMatch()!.status).toBe('dismissed');
    expect(shown).toEqual([]);
  });

  it('keeps a dismissal when the status read fails', async () => {
    db.seed('marketplace_matches', [{ id: 'mt-1', family_id: FAMILY, wanted_id: 'l-want', supply_id: 'l-have', score: 10, reason: null, status: 'dismissed' }]);
    const realFrom = db.from.bind(db);
    let reads = 0;
    (db as unknown as { from: (table: string) => object }).from = (table: string) => {
      const builder = realFrom(table);
      if (table !== 'marketplace_matches') return builder;
      const select = builder.select.bind(builder);
      builder.select = ((...args: Parameters<typeof select>) => {
        reads += 1;
        if (reads === 1) {
          (builder as { then: typeof builder.then }).then = ((ok, bad) => Promise.resolve({
            data: null, error: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null }, count: null, status: 500, statusText: 'Error',
          }).then(ok, bad)) as typeof builder.then;
        }
        return select(...args);
      }) as typeof builder.select;
      return builder;
    };

    await loadAndSnapshotMatches(db as never, FAMILY, 'user-ana');

    expect(theMatch()!.status).toBe('dismissed');
  });

  it('keeps every dismissal past db-max-rows', async () => {
    // 1,000 older match rows (to listings since removed) fill the first page.
    db = createInMemorySupabase({
      maxRows: 1000,
      uniques: { marketplace_matches: [['family_id', 'wanted_id', 'supply_id']] },
      defaults: { marketplace_matches: { status: 'active' } },
    });
    seedBoard();
    db.seed('marketplace_matches', [
      ...Array.from({ length: 1_000 }, (_, i) => ({ id: `mt-old-${String(i).padStart(4, '0')}`, family_id: FAMILY, wanted_id: `gone-w-${i}`, supply_id: `gone-s-${i}`, score: 1, reason: null, status: 'actioned' })),
      { id: 'mt-z', family_id: FAMILY, wanted_id: 'l-want', supply_id: 'l-have', score: 10, reason: null, status: 'dismissed' },
    ]);

    await loadAndSnapshotMatches(db as never, FAMILY, 'user-ana');

    expect(theMatch()!.status).toBe('dismissed');
  });
});
