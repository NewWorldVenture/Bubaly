// An auction is not settled to a winning bidder whose household has closed
// (N7-S3, the code-only stopgap).
//
// cron/close-auctions settled every due auction of an open seller, and
// marketplace_close_auction writes the 'Won at auction' order for
// highest_bidder_family_id with no look at that household's standing. A winner
// who closed after bidding got a confirmed order they cannot see, and the
// seller waited on them — the harm respondToOfferAction refuses for a closed
// buyer. What a closed winner should mean is the owner's call for the RPC; the
// cron now holds such an auction unsettled, counts it in `heldForClosedBidder`,
// and settles it on the first run after the household reopens. Held auctions
// do not starve the settleable ones behind them.
//
// Only an auction that would SELL to that bidder is held (N7-S3-reserve): one
// whose leader's max missed the reserve writes no order for anyone, so it
// closes unsold — and the seller is told — whatever became of the leader. The
// cron reads that from 0452's public `reserve_met` (the reserve and the
// leader's max are SEC-016 secrets no code names), and still reads it on a
// database 0452 has not reached.
//
// Driven through the real route against the in-memory database, with the
// settlement RPC modelled on 0483's marketplace_close_auction: sold only when
// there are bids, the leader's max meets the reserve and a leader is named;
// otherwise 'withdrawn', with no order.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const harness = vi.hoisted(() => ({ db: null as unknown, closed: [] as string[], notices: [] as { familyId: string; title: string; body: string }[] }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => harness.db }));
vi.mock('@/lib/services/scope', () => ({ systemScopeForFamily: async (_db: unknown, familyId: string) => ({ familyId }) }));
vi.mock('@/lib/services/notifications', () => ({
  notify: async (scope: { familyId: string }, n: { title: string; body: string }) => {
    harness.notices.push({ familyId: scope.familyId, title: n.title, body: n.body });
    return { ok: true, data: { created: 1 } };
  },
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { GET } = await import('@/app/api/cron/close-auctions/route');
const run = async () => {
  const res = await GET(new NextRequest('http://localhost/api/cron/close-auctions'));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

const HOUR = 3_600_000;
let db: InMemorySupabase;

function closeAuction(args: Record<string, unknown>, mem: InMemorySupabase) {
  harness.closed.push(String(args.p_listing_id));
  const listing = mem.table('marketplace_listings').find((l) => l.id === args.p_listing_id) as Row;
  const bids = Number(listing.bid_count ?? 0);
  const sold = bids > 0 && listing.highest_max_cents != null
    && Number(listing.highest_max_cents) >= Number(listing.reserve_cents ?? 0)
    && listing.highest_bidder_member_id != null && listing.highest_bidder_family_id != null;
  if (!sold) {
    Object.assign(listing, { status: 'withdrawn', claimed_by: null, auction_closed_at: args.p_now });
    return {
      ok: true, reason: 'closed', sold: false, had_bids: bids > 0, title: listing.title,
      seller_family_id: listing.family_id, winner_family_id: null, current_bid_cents: listing.current_bid_cents, order_id: null,
    };
  }
  const amount = Math.max(Number(listing.current_bid_cents), Number(listing.reserve_cents ?? 0));
  Object.assign(listing, { status: 'claimed', claimed_by: listing.highest_bidder_member_id, current_bid_cents: amount, auction_closed_at: args.p_now });
  const order = { id: `order-${String(listing.id)}`, listing_id: listing.id, amount_cents: amount, notes: 'Won at auction' };
  mem.seed('marketplace_orders', [order]);
  return {
    ok: true, reason: 'closed', sold: true, had_bids: true, title: listing.title,
    seller_family_id: listing.family_id, winner_family_id: listing.highest_bidder_family_id,
    current_bid_cents: amount, order_id: order.id,
  };
}

/** A due auction, with 0452's two generated columns computed as Postgres stores them. */
const auction = (id: string, winnerFamily: string, overrides: Row = {}): Row => {
  const row: Row = {
    id, title: `Bike ${id}`, family_id: 'seller', sale_format: 'auction', status: 'available',
    auction_ends_at: new Date(Date.now() - HOUR).toISOString(), auction_closed_at: null,
    bid_count: 2, current_bid_cents: 5_000, highest_max_cents: 6_000, reserve_cents: null,
    highest_bidder_member_id: `member-of-${winnerFamily}`, highest_bidder_family_id: winnerFamily, claimed_by: null,
    ...overrides,
  };
  const reserve = row.reserve_cents as number | null;
  return {
    ...row,
    has_reserve: reserve !== null,
    reserve_met: reserve === null || (Number(row.bid_count) > 0 && Number(row.current_bid_cents) >= reserve),
  };
};
const listing = (id: string) => db.table('marketplace_listings').find((l) => l.id === id)!;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.closed = [];
  harness.notices = [];
  db = createInMemorySupabase({ rpc: { marketplace_close_auction: closeAuction } });
  db.seed('families', [
    { id: 'seller', name: 'Seller House', closed_at: null },
    { id: 'winner-open', name: 'Open Winner', closed_at: null },
    { id: 'winner-closed', name: 'Closed Winner', closed_at: new Date(Date.now() - 2 * HOUR).toISOString() },
  ]);
  db.seed('marketplace_listings', [auction('to-open', 'winner-open'), auction('to-closed', 'winner-closed')]);
  harness.db = db;
});

describe('a due auction whose winning bidder\'s household has closed', () => {
  it('is held unsettled — no order — and counted, while the open winner\'s auction settles', async () => {
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, closed: 1, sold: 1, failed: 0, heldForClosedBidder: 1 });
    expect(harness.closed).toEqual(['to-open']);
    expect(listing('to-closed')).toMatchObject({ status: 'available', claimed_by: null, auction_closed_at: null });
    expect(db.table('marketplace_orders').map((o) => o.listing_id)).toEqual(['to-open']);
  });

  it('settles on the first run after that household reopens', async () => {
    await run();
    db.table('families').find((f) => f.id === 'winner-closed')!.closed_at = null;
    const { body } = await run();
    expect(body).toMatchObject({ closed: 1, sold: 1, heldForClosedBidder: 0 });
    expect(harness.closed).toEqual(['to-open', 'to-closed']);
    expect(listing('to-closed').status).toBe('claimed');
  });

  it('an auction with no bids still closes — it has no bidder to hold it', async () => {
    db.seed('marketplace_listings', [auction('no-bids', 'winner-open', { bid_count: 0, highest_bidder_member_id: null, highest_bidder_family_id: null })]);
    await run();
    expect(harness.closed).toEqual(expect.arrayContaining(['to-open', 'no-bids']));
  });

  it('a full batch of held auctions does not starve the settleable one behind it', async () => {
    db.seed('marketplace_listings', Array.from({ length: 60 }, (_, i) => auction(`a-held-${String(i).padStart(2, '0')}`, 'winner-closed')));
    const { body } = await run();
    expect(body).toMatchObject({ heldForClosedBidder: 61 });
    expect(harness.closed).toEqual(['to-open']);
  });

  it('an auction whose top bid missed the reserve is not held: it closes unsold, with no order, and the seller is told', async () => {
    db.seed('marketplace_listings', [auction('under-reserve', 'winner-closed', { current_bid_cents: 4_000, highest_max_cents: 4_000, reserve_cents: 5_000 })]);
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, closed: 2, sold: 1, unsold: 1, failed: 0, heldForClosedBidder: 1 });
    expect(harness.closed).toEqual(['to-open', 'under-reserve']);
    expect(listing('under-reserve')).toMatchObject({ status: 'withdrawn', claimed_by: null });
    expect(listing('under-reserve').auction_closed_at).not.toBeNull();
    expect(db.table('marketplace_orders').map((o) => o.listing_id)).toEqual(['to-open']);
    expect(harness.notices).toContainEqual({
      familyId: 'seller', title: 'Auction ended: "Bike under-reserve"',
      body: 'The reserve was not met, so it did not sell. Relist it or lower the reserve.',
    });
    expect(harness.notices.some((n) => n.familyId === 'winner-closed')).toBe(false);
    // The one that would sell to the closed household is still held.
    expect(listing('to-closed')).toMatchObject({ status: 'available', auction_closed_at: null });
  });

  it('an auction whose leader\'s max meets the reserve exactly would sell, so it is held', async () => {
    // 0483(b): a leader whose max covers the reserve shows at least the reserve.
    db.seed('marketplace_listings', [auction('at-reserve', 'winner-closed', { current_bid_cents: 5_000, highest_max_cents: 5_000, reserve_cents: 5_000 })]);
    const { body } = await run();
    expect(body).toMatchObject({ closed: 1, sold: 1, heldForClosedBidder: 2 });
    expect(harness.closed).toEqual(['to-open']);
    expect(listing('at-reserve')).toMatchObject({ status: 'available', auction_closed_at: null });
  });

  it('on a database 0452 has not reached, reads the reserve the old way and still closes the unmet one', async () => {
    db.seed('marketplace_listings', [auction('under-reserve', 'winner-closed', { current_bid_cents: 4_000, highest_max_cents: 4_000, reserve_cents: 5_000 })]);
    for (const l of db.table('marketplace_listings')) { delete l.has_reserve; delete l.reserve_met; }
    const selected: string[] = [];
    // Before 0452 the two columns do not exist: Postgres answers 42703.
    const missing = (): unknown => new Proxy({}, {
      get: (_t, property) => (property === 'then'
        ? (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { code: '42703', message: 'column marketplace_listings.has_reserve does not exist' } })
        : () => missing()),
    });
    harness.db = new Proxy(db, {
      get: (target, property) => (property === 'from'
        ? (table: string) => {
          const query = target.from(table);
          return new Proxy(query, {
            get: (q, p) => (p === 'select'
              ? (columns: string, ...rest: unknown[]) => {
                if (table === 'marketplace_listings') selected.push(columns);
                return /\breserve_met\b/.test(columns) ? missing() : (q.select as (...a: unknown[]) => unknown).call(q, columns, ...rest);
              }
              : Reflect.get(q, p)),
          });
        }
        : Reflect.get(target, property)),
    });
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, closed: 2, sold: 1, unsold: 1, heldForClosedBidder: 1 });
    expect(harness.closed).toEqual(['to-open', 'under-reserve']);
    expect(listing('under-reserve').status).toBe('withdrawn');
    expect(listing('to-closed').status).toBe('available');
    // It asked for 0452's columns first, then read the reserve the old way.
    expect(selected[0]).toContain('has_reserve, reserve_met');
    expect(selected[1]).toContain('reserve_cents');
  });
});
