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
// Driven through the real route against the in-memory database, with the
// settlement RPC modelled on 0457 (as the sibling closed-seller test does).
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const harness = vi.hoisted(() => ({ db: null as unknown, closed: [] as string[] }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => harness.db }));
vi.mock('@/lib/services/scope', () => ({ systemScopeForFamily: async (_db: unknown, familyId: string) => ({ familyId }) }));
vi.mock('@/lib/services/notifications', () => ({ notify: async () => ({ ok: true, data: { created: 1 } }) }));
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
  Object.assign(listing, { status: 'claimed', claimed_by: listing.highest_bidder_member_id, auction_closed_at: args.p_now });
  const order = { id: `order-${String(listing.id)}`, listing_id: listing.id, amount_cents: listing.current_bid_cents, notes: 'Won at auction' };
  mem.seed('marketplace_orders', [order]);
  return {
    ok: true, reason: 'closed', sold: true, had_bids: true, title: listing.title,
    seller_family_id: listing.family_id, winner_family_id: listing.highest_bidder_family_id,
    current_bid_cents: listing.current_bid_cents, order_id: order.id,
  };
}

const auction = (id: string, winnerFamily: string): Row => ({
  id, title: `Bike ${id}`, family_id: 'seller', sale_format: 'auction', status: 'available',
  auction_ends_at: new Date(Date.now() - HOUR).toISOString(), auction_closed_at: null,
  bid_count: 2, current_bid_cents: 5_000, highest_bidder_member_id: `member-of-${winnerFamily}`,
  highest_bidder_family_id: winnerFamily, claimed_by: null,
});
const listing = (id: string) => db.table('marketplace_listings').find((l) => l.id === id)!;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.closed = [];
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
    db.seed('marketplace_listings', [{ ...auction('no-bids', 'winner-open'), bid_count: 0, highest_bidder_member_id: null, highest_bidder_family_id: null }]);
    await run();
    expect(harness.closed).toEqual(expect.arrayContaining(['to-open', 'no-bids']));
  });

  it('a full batch of held auctions does not starve the settleable one behind it', async () => {
    db.seed('marketplace_listings', Array.from({ length: 60 }, (_, i) => auction(`a-held-${String(i).padStart(2, '0')}`, 'winner-closed')));
    const { body } = await run();
    expect(body).toMatchObject({ heldForClosedBidder: 61 });
    expect(harness.closed).toEqual(['to-open']);
  });
});
