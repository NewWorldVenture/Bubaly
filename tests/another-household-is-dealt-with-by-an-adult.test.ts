import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * Every auction a family can bid on, and every Buy-It-Now it can use, belongs
 * to ANOTHER household (the RPCs refuse own_listing). Bidding, buying,
 * making, countering or accepting an offer (every negotiation is between two
 * families: 0187's distinct_families check), and creating, joining or sharing
 * a listing into a circle all commit
 * the household to pay and meet another family's adult, and the RPCs accept
 * any active member for auth.uid(). The actions are where a child or teen is
 * refused; the RPC-side role check is reported separately (it needs SQL).
 *
 * Two auction rules ride along, for the same actions:
 *  - the household that already leads is not raised against itself (the proxy
 *    engine treats any higher max as a NEW leader and moves the visible price
 *    up by an increment with no competitor), and
 *  - Buy-It-Now closes at the first bid, so a fixed price cannot undercut a
 *    standing bid.
 */
const harness = vi.hoisted(() => ({ db: null as unknown, role: 'parent', memberId: 'm-self' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: 'fam-buyer', role: harness.role, member: { id: harness.memberId, family_id: 'fam-buyer' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { placeBidAction, buyNowAction } = await import('@/app/(app)/marketplace/auctions/actions');
const { makeOfferAction, respondToOfferAction } = await import('@/app/(app)/marketplace/negotiations/actions');
const { createCircleAction, joinCircleAction, shareListingAction, unshareListingAction, leaveCircleAction } = await import('@/app/(app)/marketplace/community/actions');
const { buyNowClosedByBids } = await import('@/lib/marketplace/auction');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const ADULTS_ONLY = t('actions.onlyAParentGuardianCan16');

let db: InMemorySupabase;
let calls: string[];

beforeEach(() => {
  harness.role = 'parent';
  harness.memberId = 'm-self';
  calls = [];
  const record = (name: string, reply: unknown) => () => { calls.push(name); return reply; };
  db = createInMemorySupabase({
    rpc: {
      marketplace_place_bid: record('marketplace_place_bid', { ok: true, leading: true, current_cents: 1_000 }),
      marketplace_buy_now: record('marketplace_buy_now', { ok: true, order_id: 'order-1' }),
      marketplace_negotiation_offer: record('marketplace_negotiation_offer', { ok: true, negotiation_id: 'neg-new', countered: false }),
      marketplace_leave_circle: record('marketplace_leave_circle', null),
      marketplace_negotiation_respond: record('marketplace_negotiation_respond', { ok: true, status: 'agreed', order_id: 'order-2' }),
      marketplace_create_circle: record('marketplace_create_circle', 'circle-1'),
      marketplace_join_circle: record('marketplace_join_circle', 'circle-1'),
    },
  });
  harness.db = db;
  db.seed('marketplace_listings', [{
    id: 'listing-1', family_id: 'fam-seller', sale_format: 'auction', status: 'available',
    bid_count: 0, current_bid_cents: 0, highest_bidder_family_id: null, buy_now_cents: 15_000,
  }]);
  db.seed('marketplace_negotiations', [
    { id: 'neg-cross', family_id: 'fam-seller', buyer_family_id: 'fam-buyer', status: 'open' },
  ]);
});

describe('a child or teen does not deal with another household', () => {
  it.each(['child', 'teen'])('refuses a %s bid, Buy-It-Now, cross-family accept and circle create/join', async (role) => {
    harness.role = role;
    expect(await placeBidAction({ listingId: 'listing-1', maxCents: 5_000 })).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(await buyNowAction('listing-1')).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(await respondToOfferAction({ negotiationId: 'neg-cross', action: 'accept' })).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(await createCircleAction('Street swap')).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(await joinCircleAction('ABCD-EFGH')).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(calls).toEqual([]);
  });

  it.each(['child', 'teen'])('refuses a %s opening an offer, countering one, or sharing a listing into a circle', async (role) => {
    harness.role = role;
    // The seller's adult accepting either of these makes a confirmed order
    // with the child as the buyer or the seller.
    expect(await makeOfferAction({ listingId: 'listing-1', amountCents: 900 })).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(await respondToOfferAction({ negotiationId: 'neg-cross', action: 'counter', amountCents: 900 }))
      .toEqual({ ok: false, error: ADULTS_ONLY });
    expect(await shareListingAction('listing-1', 'circle-1')).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(calls).toEqual([]);
    expect(db.table('marketplace_listing_shares')).toEqual([]);
  });

  it('still lets a teen end a thread or step back from a circle', async () => {
    harness.role = 'teen';
    expect((await respondToOfferAction({ negotiationId: 'neg-cross', action: 'decline' })).ok).toBe(true);
    expect((await respondToOfferAction({ negotiationId: 'neg-cross', action: 'withdraw' })).ok).toBe(true);
    expect((await leaveCircleAction('circle-1')).ok).toBe(true);
    db.seed('marketplace_listing_shares', [{ listing_id: 'listing-1', circle_id: 'circle-1', family_id: 'fam-buyer' }]);
    expect((await unshareListingAction('listing-1', 'circle-1')).ok).toBe(true);
    expect(calls).toEqual(['marketplace_negotiation_respond', 'marketplace_negotiation_respond', 'marketplace_leave_circle']);
  });

  it('lets a parent do all of it', async () => {
    expect((await placeBidAction({ listingId: 'listing-1', maxCents: 5_000 })).ok).toBe(true);
    expect((await respondToOfferAction({ negotiationId: 'neg-cross', action: 'accept' })).ok).toBe(true);
    expect((await createCircleAction('Street swap')).ok).toBe(true);
    expect((await buyNowAction('listing-1')).ok).toBe(true);
    expect((await makeOfferAction({ listingId: 'listing-1', amountCents: 900 })).ok).toBe(true);
    expect((await respondToOfferAction({ negotiationId: 'neg-cross', action: 'counter', amountCents: 900 })).ok).toBe(true);
    expect((await shareListingAction('listing-1', 'circle-1')).ok).toBe(true);
    expect(calls).toEqual([
      'marketplace_place_bid', 'marketplace_negotiation_respond', 'marketplace_create_circle', 'marketplace_buy_now',
      'marketplace_negotiation_offer', 'marketplace_negotiation_respond',
    ]);
    expect(db.table('marketplace_listing_shares')).toHaveLength(1);
  });
});

describe('the leading household is not bid up against itself', () => {
  it('refuses a new max from the household that already leads, and never reaches the proxy engine', async () => {
    Object.assign(db.table('marketplace_listings')[0], { bid_count: 1, current_bid_cents: 5_000, highest_bidder_family_id: 'fam-buyer' });
    const res = await placeBidAction({ listingId: 'listing-1', maxCents: 20_000 });
    expect(res).toEqual({ ok: false, error: t('actions.youAlreadyLeadThisAuction') });
    // Another adult of the same household is the same leader.
    harness.memberId = 'm-partner';
    expect((await placeBidAction({ listingId: 'listing-1', maxCents: 20_000 })).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('lets a household that is not leading bid', async () => {
    Object.assign(db.table('marketplace_listings')[0], { bid_count: 1, current_bid_cents: 5_000, highest_bidder_family_id: 'fam-other' });
    expect((await placeBidAction({ listingId: 'listing-1', maxCents: 20_000 })).ok).toBe(true);
  });
});

describe('Buy-It-Now closes at the first bid', () => {
  it('refuses Buy-It-Now once a bid stands, even one above the fixed price', async () => {
    Object.assign(db.table('marketplace_listings')[0], { bid_count: 2, current_bid_cents: 20_000, highest_bidder_family_id: 'fam-other' });
    expect(await buyNowAction('listing-1')).toEqual({ ok: false, error: t('actions.buyItNowIsnT') });
    expect(calls).toEqual([]);
  });

  it('is one rule for the panel and the action', () => {
    expect(buyNowClosedByBids(0)).toBe(false);
    expect(buyNowClosedByBids(null)).toBe(false);
    expect(buyNowClosedByBids(1)).toBe(true);
  });
});
