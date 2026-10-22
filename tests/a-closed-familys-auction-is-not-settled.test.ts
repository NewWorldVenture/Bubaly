// A closed family's auction is not settled behind its back.
//
// cron/close-auctions selected every `available` auction past its end and
// called marketplace_close_auction on it. A family that closed its account
// (families.closed_at) cannot see the sale, and every delivery cron skips its
// notices (`is('closed_at', null)`), so the cron created an order naming a
// seller who heard nothing until they reopened — and the buyer waited on them.
// The due query now joins the seller's family and takes open ones only, the
// pattern cron/wallet-allowance uses; the listing stays `available` and the
// first run after the family reopens settles it. placeBidAction and
// buyNowAction refuse a closed seller before their RPCs run, so the app takes
// no bid and creates no Buy-It-Now order for one either. (That the circle view
// still shows the listing, and a direct RPC call still reaches it, is the
// owner's SQL to close: the view and marketplace_listing_visible_to.)
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const harness = vi.hoisted(() => ({ db: null as unknown, service: null as unknown, notify: vi.fn(), scope: vi.fn(), closed: [] as string[], rpcs: [] as string[] }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => harness.service ?? harness.db, createServer: async () => harness.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-buyer' }, memberships: [],
    active: { familyId: 'fam-buyer', role: 'parent', member: { id: 'm-buyer', family_id: 'fam-buyer' } },
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/services/scope', () => ({ systemScopeForFamily: (...args: unknown[]) => harness.scope(...args) }));
vi.mock('@/lib/services/notifications', () => ({ notify: harness.notify }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { GET } = await import('@/app/api/cron/close-auctions/route');
const { placeBidAction, buyNowAction } = await import('@/app/(app)/marketplace/auctions/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);
const run = () => GET(new NextRequest('http://localhost/api/cron/close-auctions'));

const HOUR = 3_600_000;
const OPEN_SELLER = 'seller-open';
const CLOSED_SELLER = 'seller-closed';
let db: InMemorySupabase;

/** The settlement the RPC commits, modelled on 0457: claim for the leader and create the order. */
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

function auction(id: string, familyId: string): Row {
  return {
    id, title: `Bike ${id}`, family_id: familyId, sale_format: 'auction', status: 'available',
    auction_ends_at: new Date(Date.now() - HOUR).toISOString(), auction_closed_at: null,
    bid_count: 2, current_bid_cents: 5_000, highest_bidder_member_id: `winner-member-${id}`,
    highest_bidder_family_id: `winner-${id}`, claimed_by: null,
  };
}

const notifiedFamilies = () => harness.scope.mock.calls.map(([, familyId]) => familyId);
const listing = (id: string) => db.table('marketplace_listings').find((l) => l.id === id)!;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  harness.closed = [];
  harness.rpcs = [];
  harness.service = null;
  db = createInMemorySupabase({
    rpc: {
      marketplace_close_auction: closeAuction,
      marketplace_place_bid: () => { harness.rpcs.push('marketplace_place_bid'); return { ok: true, leading: true, current_cents: 5_500 }; },
      marketplace_buy_now: () => { harness.rpcs.push('marketplace_buy_now'); return { ok: true, order_id: 'order-bin' }; },
    },
  });
  db.seed('families', [
    { id: OPEN_SELLER, name: 'Open House', closed_at: null },
    { id: CLOSED_SELLER, name: 'Closed House', closed_at: new Date(Date.now() - 2 * HOUR).toISOString() },
  ]);
  db.seed('marketplace_listings', [auction('open', OPEN_SELLER), auction('closed', CLOSED_SELLER)]);
  harness.db = db;
  harness.notify.mockReset().mockResolvedValue({ ok: true, data: { created: 1 } });
  harness.scope.mockReset().mockImplementation(async (_db: unknown, familyId: string) => ({ familyId }));
});

describe('closing auctions', () => {
  it('settles the open family\'s auction and leaves the closed family\'s alone — no order, no notice', async () => {
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, closed: 1, sold: 1, failed: 0 });

    expect(harness.closed).toEqual(['open']);
    expect(listing('open').status).toBe('claimed');
    expect(listing('closed')).toMatchObject({ status: 'available', claimed_by: null, auction_closed_at: null });
    expect(db.table('marketplace_orders').map((o) => o.listing_id)).toEqual(['open']);
    expect(notifiedFamilies()).toEqual(expect.arrayContaining(['winner-open', OPEN_SELLER]));
    expect(notifiedFamilies()).not.toContain(CLOSED_SELLER);
    expect(notifiedFamilies()).not.toContain('winner-closed');
  });

  it('settles it on the first run after the family reopens', async () => {
    await run();
    db.table('families').find((f) => f.id === CLOSED_SELLER)!.closed_at = null;
    const res = await run();
    expect(await res.json()).toMatchObject({ closed: 1, sold: 1 });
    expect(harness.closed).toEqual(['open', 'closed']);
    expect(listing('closed').status).toBe('claimed');
    expect(notifiedFamilies()).toEqual(expect.arrayContaining([CLOSED_SELLER, 'winner-closed']));
  });
});

describe('bidding on, or buying, a closed family\'s listing', () => {
  /** A live auction, not yet bid on, with Buy-It-Now open. */
  const live = (id: string, familyId: string): Row => ({
    ...auction(id, familyId), auction_ends_at: new Date(Date.now() + HOUR).toISOString(),
    bid_count: 0, current_bid_cents: 0, highest_bidder_family_id: null, buy_now_cents: 15_000,
  });
  beforeEach(() => db.seed('marketplace_listings', [live('live-open', OPEN_SELLER), live('live-closed', CLOSED_SELLER)]));

  it('refuses the bid and the Buy-It-Now before either RPC runs, and creates no order', async () => {
    const closedNotice = t('actions.thisFamilyHasClosedItsAccount');
    expect(await placeBidAction({ listingId: 'live-closed', maxCents: 6_000 })).toEqual({ ok: false, error: closedNotice });
    expect(await buyNowAction('live-closed')).toEqual({ ok: false, error: closedNotice });
    expect(harness.rpcs).toEqual([]);
    expect(db.table('marketplace_orders')).toEqual([]);
  });

  it('an open family\'s listing takes both, as before (control)', async () => {
    expect(await placeBidAction({ listingId: 'live-open', maxCents: 6_000 })).toMatchObject({ ok: true });
    expect(await buyNowAction('live-open')).toEqual({ ok: true, data: { orderId: 'order-bin' } });
    expect(harness.rpcs).toEqual(['marketplace_place_bid', 'marketplace_buy_now']);
  });

  it('a seller standing that cannot be read is not an open seller: refused, retryably', async () => {
    const refused = { data: null, error: { code: 'XX000', message: 'down' } };
    const broken: Record<string, unknown> = new Proxy({}, {
      get: (_target, key) => (key === 'maybeSingle' ? async () => refused : () => broken),
    });
    harness.service = { from: () => broken };
    expect(await placeBidAction({ listingId: 'live-open', maxCents: 6_000 })).toEqual({ ok: false, error: t('actions.couldNotPlaceThatBid') });
    expect(await buyNowAction('live-open')).toEqual({ ok: false, error: t('actions.couldNotCompleteBuyIt') });
    expect(harness.rpcs).toEqual([]);
  });
});
