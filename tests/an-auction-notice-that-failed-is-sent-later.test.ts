import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * marketplace_close_auction commits the settlement (listing claimed, order
 * created) BEFORE anyone is told. The cron used to select only `available`
 * auctions, so a winner's "you won" notice that failed was never retried — the
 * listing was no longer available — and a scope lookup that threw escaped GET
 * and 500'd the run, leaving every auction it had already settled without its
 * notices. The winner's notice is their main signal that they owe payment.
 */
const harness = vi.hoisted(() => ({
  db: null as unknown,
  notify: vi.fn(),
  scope: vi.fn(),
}));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => harness.db }));
vi.mock('@/lib/services/scope', () => ({ systemScopeForFamily: (...args: unknown[]) => harness.scope(...args) }));
vi.mock('@/lib/services/notifications', () => ({ notify: harness.notify }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { GET } = await import('@/app/api/cron/close-auctions/route');
const run = () => GET(new NextRequest('http://localhost/api/cron/close-auctions'));

const HOUR = 3_600_000;
let db: InMemorySupabase;

/** The settlement the RPC commits, modelled on 0457: claim for the leader and create the order. */
function closeAuction(args: Record<string, unknown>, mem: InMemorySupabase) {
  const listing = mem.table('marketplace_listings').find((l) => l.id === args.p_listing_id) as Row;
  Object.assign(listing, {
    status: 'claimed', claimed_by: listing.highest_bidder_member_id, auction_closed_at: args.p_now,
  });
  const order = { id: `order-${String(listing.id)}`, listing_id: listing.id, amount_cents: listing.current_bid_cents, notes: 'Won at auction' };
  mem.seed('marketplace_orders', [order]);
  return {
    ok: true, reason: 'closed', sold: true, had_bids: true, title: listing.title,
    seller_family_id: listing.family_id, winner_family_id: listing.highest_bidder_family_id,
    current_bid_cents: listing.current_bid_cents, order_id: order.id,
  };
}

function auction(id: string, over: Row = {}): Row {
  return {
    id, title: `Bike ${id}`, family_id: `seller-${id}`, sale_format: 'auction', status: 'available',
    auction_ends_at: new Date(Date.now() - HOUR).toISOString(), auction_closed_at: null,
    bid_count: 2, current_bid_cents: 5_000, highest_bidder_member_id: `winner-member-${id}`,
    highest_bidder_family_id: `winner-${id}`, claimed_by: null, ...over,
  };
}

const notifiedFamilies = () => harness.scope.mock.calls.map(([, familyId]) => familyId);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db = createInMemorySupabase({ rpc: { marketplace_close_auction: closeAuction } });
  harness.db = db;
  harness.notify.mockReset();
  harness.notify.mockResolvedValue({ ok: true, data: { created: 1 } });
  harness.scope.mockReset();
  harness.scope.mockImplementation(async (_db: unknown, familyId: string) => ({ familyId }));
});

describe('closing auctions', () => {
  it('a scope lookup that throws for one auction does not abort the rest of the batch', async () => {
    db.seed('marketplace_listings', [auction('a'), auction('b')]);
    harness.scope.mockImplementation(async (_db: unknown, familyId: string) => {
      if (familyId === 'winner-a') throw new Error('connect timeout');
      return { familyId };
    });
    const res = await run();
    expect(res.status).toBe(502); // the failed notice is counted, not thrown
    const body = await res.json();
    expect(body).toMatchObject({ sold: 2 });
    // Auction b, settled after a's failure, still told both households.
    expect(notifiedFamilies()).toEqual(expect.arrayContaining(['winner-b', 'seller-b']));
  });

  it('sends every notice once per order, so a later run can re-offer it without repeating it', async () => {
    db.seed('marketplace_listings', [auction('a')]);
    await run();
    expect(harness.notify).toHaveBeenCalledTimes(2);
    for (const [, input] of harness.notify.mock.calls) {
      expect(input).toMatchObject({ once: true, relatedType: 'marketplace_orders', relatedId: 'order-a' });
    }
  });

  it('re-offers the winner\'s notice of an auction an earlier run settled', async () => {
    // Settled an hour ago; that run's notices did not go out.
    db.seed('marketplace_listings', [auction('a', {
      status: 'claimed', claimed_by: 'winner-member-a', auction_closed_at: new Date(Date.now() - HOUR).toISOString(),
    })]);
    db.seed('marketplace_orders', [{ id: 'order-a', listing_id: 'a', amount_cents: 5_000, notes: 'Won at auction' }]);
    const res = await run();
    expect(res.status).toBe(200);
    expect(notifiedFamilies().sort()).toEqual(['seller-a', 'winner-a']);
    for (const [, input] of harness.notify.mock.calls) {
      expect(input).toMatchObject({ once: true, relatedId: 'order-a' });
    }
  });

  it('does not take a Buy-It-Now sale, or one settled long ago, for a lost winner notice', async () => {
    db.seed('marketplace_listings', [
      // Bought outright by someone who was not the leading bidder.
      auction('bin', { status: 'claimed', claimed_by: 'someone-else', auction_closed_at: new Date(Date.now() - HOUR).toISOString() }),
      auction('old', { status: 'claimed', claimed_by: 'winner-member-old', auction_closed_at: new Date(Date.now() - 30 * 24 * HOUR).toISOString() }),
    ]);
    db.seed('marketplace_orders', [{ id: 'order-old', listing_id: 'old', amount_cents: 5_000, notes: 'Won at auction' }]);
    const res = await run();
    expect(res.status).toBe(200);
    expect(harness.notify).not.toHaveBeenCalled();
  });

  it('re-offers every lost notice in the window, not only the 50 newest', async () => {
    // 260 auctions settled over the last few days, none of whose notices went
    // out: more than one page, and the oldest are the ones a newest-first
    // read capped at 50 never reached.
    const ids = Array.from({ length: 260 }, (_, i) => `s${String(i).padStart(3, '0')}`);
    db.seed('marketplace_listings', ids.map((id, i) => auction(id, {
      status: 'claimed', claimed_by: `winner-member-${id}`,
      auction_closed_at: new Date(Date.now() - (2 + i * 0.25) * HOUR).toISOString(),
    })));
    db.seed('marketplace_orders', ids.map((id) => ({ id: `order-${id}`, listing_id: id, amount_cents: 5_000, notes: 'Won at auction' })));
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rechecked: 260, failed: 0 });
    const orders = new Set(harness.notify.mock.calls.map(([, input]) => (input as { relatedId: string }).relatedId));
    expect(orders.size).toBe(260);
    // The oldest settlement in the window is among them.
    expect(orders.has('order-s259')).toBe(true);
  });

  it('counts a family with no notice scope as skipped, not as a failed run', async () => {
    db.seed('marketplace_listings', [
      auction('gone', { status: 'claimed', claimed_by: 'winner-member-gone', auction_closed_at: new Date(Date.now() - HOUR).toISOString() }),
      auction('live'),
    ]);
    db.seed('marketplace_orders', [{ id: 'order-gone', listing_id: 'gone', amount_cents: 5_000, notes: 'Won at auction' }]);
    // The winner of `gone` has no family row any more: its scope is null on
    // every run for the whole retry window.
    harness.scope.mockImplementation(async (_db: unknown, familyId: string) => (familyId === 'winner-gone' ? null : { familyId }));
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sold: 1, failed: 0, skipped: 1 });
    expect(console.warn).toHaveBeenCalled();
    // The seller of `gone` and both households of `live` were still told.
    expect(harness.notify).toHaveBeenCalledTimes(3);
  });

  it('still fails the run when a notice write fails', async () => {
    db.seed('marketplace_listings', [auction('a')]);
    harness.notify.mockResolvedValue({ ok: false, error: 'insert failed' });
    const res = await run();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ failed: 1, skipped: 0 });
  });
});
