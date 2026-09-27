import { describe, expect, it } from 'vitest';
import { reserveMet } from '@/lib/marketplace/auction';
import { RESERVE_VIEW_COLUMNS, deriveReserveView, isReserveViewMissing, readWithReserveView } from '@/lib/marketplace/reserve-view';

// The application deploys ahead of its migrations — nothing from 0318 on has
// reached production (docs/PENDING_PROD_MIGRATIONS.md). 0452 adds `has_reserve`
// and `reserve_met` and takes `reserve_cents` away from clients, so a read that
// names only one side breaks the marketplace on the other: before 0452 the new
// columns do not exist (42703), after it the old one is refused (42501). These
// pin that the auction reads work on both, and that nothing else is mistaken
// for the old schema.

type Row = { id: string; current_bid_cents: number; bid_count: number; reserve_cents?: number | null; has_reserve?: boolean; reserve_met?: boolean };
const COLUMNS = `id, current_bid_cents, bid_count, ${RESERVE_VIEW_COLUMNS}`;
const missing = (column: string) => ({ code: '42703', message: `column marketplace_listings.${column} does not exist` });

/** A database on one side of 0452, answering the column list it is given. */
function database(applied: boolean, rows: Row[]) {
  const asked: string[] = [];
  const run = (columns: string) => {
    asked.push(columns);
    if (!applied && columns.includes('has_reserve')) return Promise.resolve({ data: null, error: missing('has_reserve') });
    if (applied && columns.includes('reserve_cents')) {
      return Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied for table marketplace_listings' } });
    }
    return Promise.resolve({ data: rows, error: null });
  };
  return { run, asked };
}

describe('an auction read works on either side of 0452', () => {
  it('reads the two columns directly once 0452 is applied, and asks once', async () => {
    const db = database(true, [{ id: 'a', current_bid_cents: 500, bid_count: 1, has_reserve: true, reserve_met: false }]);
    const result = await readWithReserveView<Row[]>(COLUMNS, db.run);
    expect(result.error).toBeNull();
    expect(result.data?.[0]).toMatchObject({ has_reserve: true, reserve_met: false });
    expect(db.asked).toEqual([COLUMNS]);
  });

  it('derives the same two facts from reserve_cents before 0452, without handing the figure on', async () => {
    const db = database(false, [
      { id: 'no-reserve', current_bid_cents: 0, bid_count: 0, reserve_cents: null },
      { id: 'below', current_bid_cents: 1000, bid_count: 2, reserve_cents: 20000 },
      { id: 'met', current_bid_cents: 25000, bid_count: 4, reserve_cents: 20000 },
      { id: 'no-bids', current_bid_cents: 30000, bid_count: 0, reserve_cents: 20000 },
    ]);
    const result = await readWithReserveView<Row[]>(COLUMNS, db.run);
    expect(result.error).toBeNull();
    expect(result.data?.map((r) => [r.id, r.has_reserve, r.reserve_met])).toEqual([
      ['no-reserve', false, true], ['below', true, false], ['met', true, true], ['no-bids', true, false],
    ]);
    for (const row of result.data ?? []) expect(row).not.toHaveProperty('reserve_cents');
    expect(db.asked).toEqual([COLUMNS, 'id, current_bid_cents, bid_count, reserve_cents']);
  });

  it('asks for the price and bid count on the fallback when the caller did not', async () => {
    const db = database(false, [{ id: 'x', current_bid_cents: 100, bid_count: 1, reserve_cents: 50 }]);
    await readWithReserveView<Row[]>(`id, ${RESERVE_VIEW_COLUMNS}`, db.run);
    expect(db.asked[1]).toBe('id, reserve_cents, current_bid_cents, bid_count');
  });

  it('handles a single-row read the same way', async () => {
    const run = (columns: string) => Promise.resolve(columns.includes('has_reserve')
      ? { data: null, error: missing('reserve_met') }
      : { data: { id: 'one', current_bid_cents: 700, bid_count: 3, reserve_cents: 600 }, error: null });
    const result = await readWithReserveView<Row>(COLUMNS, run);
    expect(result.data).toMatchObject({ id: 'one', has_reserve: true, reserve_met: true });
  });

  it('never reads a refusal or an outage as the old schema', async () => {
    for (const error of [
      { code: '42501', message: 'permission denied for table marketplace_listings' },
      { code: '08006', message: 'connection failure' },
      { code: '42703', message: 'column marketplace_listings.nickname does not exist' },
    ]) {
      const asked: string[] = [];
      const result = await readWithReserveView<Row[]>(COLUMNS, (columns) => { asked.push(columns); return Promise.resolve({ data: null, error }); });
      expect(result.error).toBe(error);
      expect(asked, `${error.code} must not trigger the reserve_cents fallback`).toEqual([COLUMNS]);
    }
    expect(isReserveViewMissing(null)).toBe(false);
  });

  it('derives exactly what reserveMet() and the generated column say', () => {
    for (const [reserve, price, bids] of [[null, 0, 0], [100, 99, 1], [100, 100, 1], [100, 500, 0], [null, 50, 2]] as const) {
      const derived = deriveReserveView({ reserve_cents: reserve, current_bid_cents: price, bid_count: bids });
      expect(derived.reserve_met).toBe(reserveMet({ reserveCents: reserve, currentBidCents: price, bidCount: bids }));
      expect(derived.has_reserve).toBe(reserve !== null);
    }
  });

  it('refuses a column list that does not ask for the reserve view', async () => {
    await expect(readWithReserveView('id, title', () => Promise.resolve({ data: [], error: null }))).rejects.toThrow(/reserve view/);
  });
});
