// An auction bid or a Buy-It-Now is a parent's or an adult's, and lands as
// their own household (Register B ACTION-A071862AEF49, ACTION-76449256AC69).
//
// THE POLICY, from the sources rather than from the action:
//  - lib/constants/roles.ts: isManager = parent or adult.
//  - supabase/migrations/0483 (the last definition of marketplace_place_bid
//    and marketplace_buy_now, section 7): both refuse a caller who is not
//    can_manage_family of the bidding/buying household ('manager_only'), and
//    both refuse a member who is not the caller's own active row in the family
//    the call names ('unauthorized').
//  - The action's own comments: every auction a family can reach is another
//    household's, so a bid or a buy commits the household to pay and meet
//    another family's adult.
//  - No plan gate (lib/constants/feature-catalog.ts lists no marketplace
//    entry) and no guest withholding (lib/auth/guest-scope.ts does not list
//    /marketplace), so a caregiver or a guest is refused by the manager rule
//    alone.
//
// "Cross-family" in a marketplace that is between families by design: bidding
// on household B's auction is the normal case. What must not happen is a bid
// recorded as anyone but the caller's own member and household, a household
// raised against itself, or a commitment to a seller family that closed.
//
// The two RPCs are SECURITY DEFINER SQL the unit layer cannot run, so each is
// modelled to write what it was handed: a bid row under p_bidder_* and an order
// under p_buyer_*. Reading those rows back shows what identity the REAL action
// forwarded, and their absence shows a refusal reached nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const FAM_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FAM_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const FAM_C = 'cccccccc-0000-4000-8000-00000000000c';
const LISTING_B = 'b1000000-0000-4000-8000-000000000001';
const LISTING_A = 'a1000000-0000-4000-8000-000000000001';
const LISTING_C = 'c1000000-0000-4000-8000-000000000001';
const UNSEEN = 'd1000000-0000-4000-8000-000000000001';

const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Role = (typeof ROLES)[number];
const memberOf = (role: Role) => `a0000000-0000-4000-8000-0000000000${String(ROLES.indexOf(role) + 10)}`;

const harness = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as unknown,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (!harness.ctx) throw new Error('NEXT_REDIRECT:/login');
    return harness.ctx;
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { placeBidAction, buyNowAction } = await import('@/app/(app)/marketplace/auctions/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const ADULTS_ONLY = t('actions.onlyAParentGuardianCan16');
const CLOSED = t('actions.thisFamilyHasClosedItsAccount');

let db: InMemorySupabase;

function signInAs(role: Role) {
  const membership = { familyId: FAM_A, role, member: { id: memberOf(role), family_id: FAM_A } };
  harness.ctx = { user: { id: `user-${role}`, email: `${role}@example.com` }, memberships: [membership], active: membership };
}

/** Every table a bid or a buy could touch, to show a refusal touched none of it. */
const snapshot = () => structuredClone({
  listings: db.table('marketplace_listings'),
  bids: db.table('marketplace_bids'),
  orders: db.table('marketplace_orders'),
});

const listing = (id: string, familyId: string, extra: Row = {}): Row => ({
  id, family_id: familyId, member_id: null, sale_format: 'auction', status: 'available',
  starting_bid_cents: 1_000, current_bid_cents: 0, bid_count: 0, highest_bidder_family_id: null,
  buy_now_cents: 15_000, ...extra,
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  harness.rpcCalls = [];
  db = createInMemorySupabase({
    rpc: {
      // Models what 0483's functions persist, from the arguments they are given.
      marketplace_place_bid: (args) => {
        harness.rpcCalls.push({ name: 'marketplace_place_bid', args });
        const row = db.table('marketplace_listings').find((r) => r.id === args.p_listing_id);
        if (!row) return { ok: false, reason: 'not_found' };
        if (row.family_id === args.p_bidder_family_id) return { ok: false, reason: 'own_listing' };
        db.seed('marketplace_bids', [{
          listing_id: args.p_listing_id, bidder_family_id: args.p_bidder_family_id,
          bidder_member_id: args.p_bidder_member_id, max_cents: args.p_max_cents,
        }]);
        Object.assign(row, { highest_bidder_family_id: args.p_bidder_family_id, bid_count: Number(row.bid_count) + 1, current_bid_cents: row.starting_bid_cents });
        return { ok: true, leading: true, current_cents: row.starting_bid_cents };
      },
      marketplace_buy_now: (args) => {
        harness.rpcCalls.push({ name: 'marketplace_buy_now', args });
        const row = db.table('marketplace_listings').find((r) => r.id === args.p_listing_id);
        if (!row) return { ok: false, reason: 'not_found' };
        if (row.family_id === args.p_buyer_family_id) return { ok: false, reason: 'own_listing' };
        const id = `order-${String(args.p_listing_id)}`;
        db.seed('marketplace_orders', [{
          id, listing_id: args.p_listing_id, family_id: row.family_id,
          buyer_family_id: args.p_buyer_family_id, buyer_member_id: args.p_buyer_member_id, amount_cents: row.buy_now_cents,
        }]);
        row.status = 'claimed';
        return { ok: true, order_id: id };
      },
    },
  });
  harness.db = db;
  db.seed('families', [
    { id: FAM_A, closed_at: null },
    { id: FAM_B, closed_at: null },
    { id: FAM_C, closed_at: '2026-10-01T00:00:00Z' },
  ]);
  db.seed('marketplace_listings', [
    listing(LISTING_B, FAM_B),
    listing(LISTING_A, FAM_A),
    listing(LISTING_C, FAM_C),
  ]);
});

describe('placeBidAction, each role of household A on household B\'s auction', () => {
  it.each(['parent', 'adult'] as const)('ACTION-A071862AEF49 a %s bids, and the bid is recorded as their own member and household', async (role) => {
    signInAs(role);
    const res = await placeBidAction({ listingId: LISTING_B, maxCents: 5_000 });
    expect(res).toEqual({ ok: true, data: { leading: true, currentCents: 1_000, extended: undefined } });
    expect(db.table('marketplace_bids')).toHaveLength(1);
    expect(db.table('marketplace_bids')).toMatchObject([
      { listing_id: LISTING_B, bidder_family_id: FAM_A, bidder_member_id: memberOf(role), max_cents: 5_000 },
    ]);
    expect(db.table('marketplace_listings').find((r) => r.id === LISTING_B)).toMatchObject({ highest_bidder_family_id: FAM_A, bid_count: 1 });
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('ACTION-A071862AEF49 a %s is refused and nothing is bid', async (role) => {
    signInAs(role);
    const before = snapshot();
    expect(await placeBidAction({ listingId: LISTING_B, maxCents: 5_000 })).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(snapshot()).toEqual(before);
    expect(db.table('marketplace_bids')).toEqual([]);
    expect(harness.rpcCalls).toEqual([]);
  });

  it('ACTION-A071862AEF49 a signed-out caller is sent away before anything is read or bid', async () => {
    harness.ctx = null;
    const before = snapshot();
    await expect(placeBidAction({ listingId: LISTING_B, maxCents: 5_000 })).rejects.toThrow(/NEXT_REDIRECT/);
    expect(snapshot()).toEqual(before);
    expect(harness.rpcCalls).toEqual([]);
  });
});

describe('placeBidAction across households', () => {
  it('ACTION-A071862AEF49 a household that already leads is not raised against itself, by any of its adults', async () => {
    Object.assign(db.table('marketplace_listings').find((r) => r.id === LISTING_B)!, { bid_count: 1, current_bid_cents: 3_000, highest_bidder_family_id: FAM_A });
    for (const role of ['parent', 'adult'] as const) {
      signInAs(role);
      const before = snapshot();
      expect(await placeBidAction({ listingId: LISTING_B, maxCents: 9_000 }), role).toEqual({ ok: false, error: t('actions.youAlreadyLeadThisAuction') });
      expect(snapshot()).toEqual(before);
    }
    expect(harness.rpcCalls).toEqual([]);
  });

  it('ACTION-A071862AEF49 a household leading on another listing is not stopped here: the leader check is per household, not per caller', async () => {
    Object.assign(db.table('marketplace_listings').find((r) => r.id === LISTING_B)!, { bid_count: 1, current_bid_cents: 3_000, highest_bidder_family_id: FAM_C });
    signInAs('parent');
    expect((await placeBidAction({ listingId: LISTING_B, maxCents: 9_000 })).ok).toBe(true);
    expect(db.table('marketplace_bids').map((b) => b.bidder_family_id)).toEqual([FAM_A]);
  });

  it('ACTION-A071862AEF49 a bid on a seller household that closed is refused before the RPC', async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await placeBidAction({ listingId: LISTING_C, maxCents: 5_000 })).toEqual({ ok: false, error: CLOSED });
    expect(snapshot()).toEqual(before);
    expect(harness.rpcCalls).toEqual([]);
  });

  it('ACTION-A071862AEF49 a listing the household cannot see is "no longer exists", and nothing is written in A or B', async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await placeBidAction({ listingId: UNSEEN, maxCents: 5_000 })).toEqual({ ok: false, error: t('actions.thatListingNoLongerExists') });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-A071862AEF49 the household\'s own auction is refused as own_listing, and nothing is written', async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await placeBidAction({ listingId: LISTING_A, maxCents: 5_000 })).toEqual({ ok: false, error: t('actions.youCanTBidOn') });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-A071862AEF49 the RPC is always told the caller\'s own member and household, never the seller\'s', async () => {
    signInAs('adult');
    await placeBidAction({ listingId: LISTING_B, maxCents: 4_000 });
    expect(harness.rpcCalls).toEqual([{ name: 'marketplace_place_bid', args: {
      p_listing_id: LISTING_B, p_bidder_member_id: memberOf('adult'), p_bidder_family_id: FAM_A, p_max_cents: 4_000,
    } }]);
  });
});

describe('buyNowAction, each role of household A on household B\'s auction', () => {
  it.each(['parent', 'adult'] as const)('ACTION-76449256AC69 a %s buys, and the order names their member and household as the buyer', async (role) => {
    signInAs(role);
    const res = await buyNowAction(LISTING_B);
    expect(res).toEqual({ ok: true, data: { orderId: `order-${LISTING_B}` } });
    expect(db.table('marketplace_orders')).toHaveLength(1);
    expect(db.table('marketplace_orders')).toMatchObject([{
      id: `order-${LISTING_B}`, listing_id: LISTING_B, family_id: FAM_B,
      buyer_family_id: FAM_A, buyer_member_id: memberOf(role), amount_cents: 15_000,
    }]);
    expect(db.table('marketplace_listings').find((r) => r.id === LISTING_B)?.status).toBe('claimed');
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('ACTION-76449256AC69 a %s is refused and no order is made', async (role) => {
    signInAs(role);
    const before = snapshot();
    expect(await buyNowAction(LISTING_B)).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(snapshot()).toEqual(before);
    expect(db.table('marketplace_orders')).toEqual([]);
    expect(harness.rpcCalls).toEqual([]);
  });

  it('ACTION-76449256AC69 a signed-out caller is sent away and no order is made', async () => {
    harness.ctx = null;
    await expect(buyNowAction(LISTING_B)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(db.table('marketplace_orders')).toEqual([]);
    expect(harness.rpcCalls).toEqual([]);
  });
});

describe('buyNowAction across households', () => {
  it('ACTION-76449256AC69 Buy-It-Now is closed once another household has bid, so it cannot undercut them', async () => {
    Object.assign(db.table('marketplace_listings').find((r) => r.id === LISTING_B)!, { bid_count: 1, current_bid_cents: 20_000, highest_bidder_family_id: FAM_C });
    signInAs('parent');
    const before = snapshot();
    expect(await buyNowAction(LISTING_B)).toEqual({ ok: false, error: t('actions.buyItNowIsnT') });
    expect(snapshot()).toEqual(before);
    expect(harness.rpcCalls).toEqual([]);
  });

  it('ACTION-76449256AC69 a seller household that closed is not bought from', async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await buyNowAction(LISTING_C)).toEqual({ ok: false, error: CLOSED });
    expect(snapshot()).toEqual(before);
    expect(harness.rpcCalls).toEqual([]);
  });

  it('ACTION-76449256AC69 a listing the household cannot see is "not found", before the RPC', async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await buyNowAction(UNSEEN)).toEqual({ ok: false, error: t('actions.listingNotFound') });
    expect(snapshot()).toEqual(before);
    expect(harness.rpcCalls).toEqual([]);
  });

  it('ACTION-76449256AC69 the household\'s own auction is refused as own_listing, and nothing is written', async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await buyNowAction(LISTING_A)).toEqual({ ok: false, error: t('actions.youCanTBuyYour') });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-76449256AC69 the RPC is told the caller\'s own member and household', async () => {
    signInAs('parent');
    await buyNowAction(LISTING_B);
    expect(harness.rpcCalls).toEqual([{ name: 'marketplace_buy_now', args: {
      p_listing_id: LISTING_B, p_buyer_member_id: memberOf('parent'), p_buyer_family_id: FAM_A,
    } }]);
  });
});
