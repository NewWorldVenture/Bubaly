// An offer is made, countered or accepted by a parent or an adult, and only on
// the household's own threads (Register B ACTION-413ABC6A45E6,
// ACTION-49DA06B7508F).
//
// THE POLICY, from the sources rather than from the action:
//  - lib/constants/roles.ts: isManager = parent or adult.
//  - supabase/migrations/0483 (the last definitions of
//    marketplace_negotiation_offer and marketplace_negotiation_respond,
//    section 7): making an offer, countering and accepting need
//    can_manage_family of the acting side ('manager_only'); withdrawing (the
//    buyer) and declining (the seller) "only end a thread, and stay open to
//    the party themselves". The respond RPC finds the caller by
//    marketplace_member_id and answers 'not_authorized' to anyone who is not
//    the thread's buyer member or the listing's seller member.
//  - 0187: a negotiation is always between two households
//    (family_id <> buyer_family_id).
//  - The action's header says the same, and adds that no deal is made with a
//    household that closed (lib/marketplace/seller-standing.ts).
//  - No plan gate (lib/constants/feature-catalog.ts) and no guest withholding
//    (lib/auth/guest-scope.ts) for /marketplace.
//
// "Cross-family" here is household A acting on a thread between B and C, to
// which it is not a party. Acting as the other party of A's own deal is the
// normal case.
//
// Both RPCs are SECURITY DEFINER SQL, so each is modelled from 0483: the offer
// opens a thread under the p_buyer_* it is handed, and respond identifies the
// caller the way marketplace_member_id does (the caller's own member row in
// the family asked about) and applies 0483's party, role and turn rules. The
// rows read back are what the REAL action's arguments produced.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const FAM_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FAM_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const FAM_C = 'cccccccc-0000-4000-8000-00000000000c';
const FAM_D = 'dddddddd-0000-4000-8000-00000000000d';
const B_SELLER = 'b0000000-0000-4000-8000-000000000001';
const C_BUYER = 'c0000000-0000-4000-8000-000000000001';
const B_BUYER = 'b0000000-0000-4000-8000-000000000002';
const LISTING_B = 'b1000000-0000-4000-8000-000000000001';
const LISTING_D = 'd1000000-0000-4000-8000-000000000001';
const LISTING_A = 'a1000000-0000-4000-8000-000000000001';
const UNSEEN = 'e1000000-0000-4000-8000-000000000001';
const THREAD_A_BUYS = 'a2000000-0000-4000-8000-000000000001';
const THREAD_A_SELLS = 'a2000000-0000-4000-8000-000000000002';
const THREAD_A_BUYS_FROM_CLOSED = 'a2000000-0000-4000-8000-000000000003';
const THREAD_A_SELLS_TO_CLOSED = 'a2000000-0000-4000-8000-000000000004';
const THREAD_B_AND_C = 'b2000000-0000-4000-8000-000000000001';

const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Role = (typeof ROLES)[number];
const memberOf = (role: Role) => `a0000000-0000-4000-8000-0000000000${String(ROLES.indexOf(role) + 10)}`;

type Membership = { familyId: string; role: string; member: { id: string; family_id: string } };
const harness = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as null | { user: { id: string; email: string }; memberships: Membership[]; active: Membership },
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

const { makeOfferAction, respondToOfferAction } = await import('@/app/(app)/marketplace/negotiations/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

const ADULTS_ONLY = t('actions.onlyAParentGuardianCan16');
const CLOSED = t('actions.thisFamilyHasClosedItsAccount');
const NOT_PART_OF = t('actions.youReNotPartOf');

let db: InMemorySupabase;

function signInAs(role: Role) {
  const membership = { familyId: FAM_A, role, member: { id: memberOf(role), family_id: FAM_A } };
  harness.ctx = { user: { id: `user-${role}`, email: `${role}@example.com` }, memberships: [membership], active: membership };
}

/** marketplace_member_id(family): the caller's own member row in that family, as 0154 answers it. */
const callerMemberIn = (familyId: unknown) => harness.ctx?.memberships.find((m) => m.familyId === familyId);

const snapshot = () => structuredClone({
  negotiations: db.table('marketplace_negotiations'),
  rounds: db.table('marketplace_negotiation_rounds'),
  orders: db.table('marketplace_orders'),
  listings: db.table('marketplace_listings'),
});

const thread = (id: string, listingId: string, sellerFamily: string, buyerFamily: string, buyerMember: string, lastActor: 'buyer' | 'seller'): Row => ({
  id, listing_id: listingId, family_id: sellerFamily, buyer_family_id: buyerFamily, buyer_member_id: buyerMember,
  status: 'open', current_amount_cents: 7_000, last_actor: lastActor,
});

/** Seeds A's own threads with the signed-in member as A's party on each. */
function seedThreadsFor(role: Role) {
  db.table('marketplace_listings').find((l) => l.id === LISTING_A)!.member_id = memberOf(role);
  db.seed('marketplace_negotiations', [
    // A buys B's desk; B countered, so it is A's turn.
    thread(THREAD_A_BUYS, LISTING_B, FAM_B, FAM_A, memberOf(role), 'seller'),
    // B offers on A's listing; it is A's turn.
    thread(THREAD_A_SELLS, LISTING_A, FAM_A, FAM_B, B_BUYER, 'buyer'),
    // C, whose household has closed, offers on A's listing.
    thread(THREAD_A_SELLS_TO_CLOSED, LISTING_A, FAM_A, FAM_C, C_BUYER, 'buyer'),
    // A buys from D, whose household has closed.
    thread(THREAD_A_BUYS_FROM_CLOSED, LISTING_D, FAM_D, FAM_A, memberOf(role), 'seller'),
  ]);
}

const threadRow = (id: string) => db.table('marketplace_negotiations').find((n) => n.id === id);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  harness.rpcCalls = [];
  db = createInMemorySupabase({
    rpc: {
      marketplace_negotiation_offer: (args) => {
        harness.rpcCalls.push({ name: 'marketplace_negotiation_offer', args });
        const listing = db.table('marketplace_listings').find((l) => l.id === args.p_listing);
        if (!listing) return { ok: false, reason: 'not_found' };
        const caller = callerMemberIn(args.p_buyer_family);
        if (!caller || caller.member.id !== args.p_buyer_member) return { ok: false, reason: 'not_authorized' };
        if (!['parent', 'adult'].includes(caller.role)) return { ok: false, reason: 'manager_only' };
        if (listing.family_id === args.p_buyer_family) return { ok: false, reason: 'own_listing' };
        const id = `neg-${String(args.p_listing)}`;
        db.seed('marketplace_negotiations', [{
          id, listing_id: listing.id, family_id: listing.family_id, buyer_family_id: args.p_buyer_family,
          buyer_member_id: args.p_buyer_member, status: 'open', current_amount_cents: args.p_amount, last_actor: 'buyer',
        }]);
        db.seed('marketplace_negotiation_rounds', [{ negotiation_id: id, actor_member_id: args.p_buyer_member, kind: 'offer', amount_cents: args.p_amount }]);
        return { ok: true, negotiation_id: id, countered: false };
      },
      marketplace_negotiation_respond: (args) => {
        harness.rpcCalls.push({ name: 'marketplace_negotiation_respond', args });
        const neg = db.table('marketplace_negotiations').find((n) => n.id === args.p_negotiation);
        if (!neg) return { ok: false, reason: 'not_found' };
        const listing = db.table('marketplace_listings').find((l) => l.id === neg.listing_id);
        if (!listing) return { ok: false, reason: 'listing_missing' };
        if (neg.status !== 'open') return { ok: false, reason: 'not_open' };
        const asSeller = callerMemberIn(listing.family_id);
        const asBuyer = callerMemberIn(neg.buyer_family_id);
        const side = asSeller && asSeller.member.id === listing.member_id ? { role: 'seller', who: asSeller }
          : asBuyer && asBuyer.member.id === neg.buyer_member_id ? { role: 'buyer', who: asBuyer } : null;
        if (!side) return { ok: false, reason: 'not_authorized' };
        const round = (kind: string) => db.seed('marketplace_negotiation_rounds', [{ negotiation_id: neg.id, actor_member_id: side.who.member.id, kind, amount_cents: args.p_amount ?? null }]);
        if (args.p_action === 'withdraw') {
          if (side.role !== 'buyer') return { ok: false, reason: 'buyer_only' };
          neg.status = 'withdrawn'; round('withdraw');
          return { ok: true, status: 'withdrawn' };
        }
        if (args.p_action === 'decline') {
          if (side.role !== 'seller') return { ok: false, reason: 'seller_only' };
          neg.status = 'declined'; round('decline');
          return { ok: true, status: 'declined' };
        }
        if (!['parent', 'adult'].includes(side.who.role)) return { ok: false, reason: 'manager_only' };
        if (neg.last_actor === side.role) return { ok: false, reason: 'not_your_turn' };
        if (args.p_action === 'counter') {
          Object.assign(neg, { current_amount_cents: args.p_amount, last_actor: side.role }); round('counter');
          return { ok: true, status: 'open' };
        }
        neg.status = 'agreed'; round('accept');
        db.seed('marketplace_orders', [{ id: `order-${String(neg.id)}`, negotiation_id: neg.id, family_id: neg.family_id, buyer_family_id: neg.buyer_family_id, amount_cents: neg.current_amount_cents }]);
        return { ok: true, status: 'agreed', order_id: `order-${String(neg.id)}` };
      },
    },
  });
  harness.db = db;
  db.seed('families', [
    { id: FAM_A, closed_at: null },
    { id: FAM_B, closed_at: null },
    // C has closed: A must not learn that from a thread it is not part of.
    { id: FAM_C, closed_at: '2026-10-01T00:00:00Z' },
    { id: FAM_D, closed_at: '2026-10-01T00:00:00Z' },
  ]);
  db.seed('marketplace_listings', [
    { id: LISTING_B, family_id: FAM_B, member_id: B_SELLER, kind: 'sell', status: 'available', price_cents: 10_000 },
    { id: LISTING_D, family_id: FAM_D, member_id: null, kind: 'sell', status: 'available', price_cents: 10_000 },
    { id: LISTING_A, family_id: FAM_A, member_id: null, kind: 'sell', status: 'available', price_cents: 10_000 },
  ]);
  db.seed('marketplace_negotiations', [thread(THREAD_B_AND_C, LISTING_B, FAM_B, FAM_C, C_BUYER, 'seller')]);
});

describe('makeOfferAction, each role of household A on household B\'s listing', () => {
  it.each(['parent', 'adult'] as const)('ACTION-413ABC6A45E6 a %s opens a thread, recorded as their own member and household', async (role) => {
    signInAs(role);
    const res = await makeOfferAction({ listingId: LISTING_B, amountCents: 8_000, message: ' Would you take 80? ' });
    expect(res).toEqual({ ok: true, data: { negotiationId: `neg-${LISTING_B}`, countered: false } });
    expect(threadRow(`neg-${LISTING_B}`)).toMatchObject({
      listing_id: LISTING_B, family_id: FAM_B, buyer_family_id: FAM_A, buyer_member_id: memberOf(role), current_amount_cents: 8_000, status: 'open',
    });
    expect(harness.rpcCalls).toEqual([{ name: 'marketplace_negotiation_offer', args: {
      p_listing: LISTING_B, p_buyer_member: memberOf(role), p_buyer_family: FAM_A, p_amount: 8_000, p_message: 'Would you take 80?',
    } }]);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('ACTION-413ABC6A45E6 a %s is refused and no thread is opened', async (role) => {
    signInAs(role);
    const before = snapshot();
    expect(await makeOfferAction({ listingId: LISTING_B, amountCents: 8_000 })).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(snapshot()).toEqual(before);
    expect(harness.rpcCalls).toEqual([]);
  });

  it('ACTION-413ABC6A45E6 a signed-out caller is sent away and nothing is opened', async () => {
    harness.ctx = null;
    const before = snapshot();
    await expect(makeOfferAction({ listingId: LISTING_B, amountCents: 8_000 })).rejects.toThrow(/NEXT_REDIRECT/);
    expect(snapshot()).toEqual(before);
    expect(harness.rpcCalls).toEqual([]);
  });
});

describe('makeOfferAction across households', () => {
  it('ACTION-413ABC6A45E6 an offer to a seller household that closed is refused before the RPC', async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await makeOfferAction({ listingId: LISTING_D, amountCents: 8_000 })).toEqual({ ok: false, error: CLOSED });
    expect(snapshot()).toEqual(before);
    expect(harness.rpcCalls).toEqual([]);
  });

  it('ACTION-413ABC6A45E6 a listing the household cannot see is "no longer exists", and nothing is written', async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await makeOfferAction({ listingId: UNSEEN, amountCents: 8_000 })).toEqual({ ok: false, error: t('actions.thatListingNoLongerExists') });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-413ABC6A45E6 the household\'s own listing is refused as own_listing, and nothing is written', async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await makeOfferAction({ listingId: LISTING_A, amountCents: 8_000 })).toEqual({ ok: false, error: t('actions.youCanTMakeAn') });
    expect(snapshot()).toEqual(before);
  });
});

describe('respondToOfferAction, each role of household A on its own threads', () => {
  it.each(['parent', 'adult'] as const)('ACTION-49DA06B7508F a %s accepts B\'s counter, and the order is made with B', async (role) => {
    signInAs(role);
    seedThreadsFor(role);
    const res = await respondToOfferAction({ negotiationId: THREAD_A_BUYS, action: 'accept', listingId: LISTING_B });
    expect(res).toEqual({ ok: true, data: { status: 'agreed', orderId: `order-${THREAD_A_BUYS}` } });
    expect(threadRow(THREAD_A_BUYS)?.status).toBe('agreed');
    expect(db.table('marketplace_orders')).toHaveLength(1);
    expect(db.table('marketplace_orders')).toMatchObject([{ negotiation_id: THREAD_A_BUYS, family_id: FAM_B, buyer_family_id: FAM_A, amount_cents: 7_000 }]);
  });

  it.each(['parent', 'adult'] as const)('ACTION-49DA06B7508F a %s counters on A\'s own listing', async (role) => {
    signInAs(role);
    seedThreadsFor(role);
    const res = await respondToOfferAction({ negotiationId: THREAD_A_SELLS, action: 'counter', amountCents: 9_000 });
    expect(res).toEqual({ ok: true, data: { status: 'open', orderId: undefined } });
    expect(threadRow(THREAD_A_SELLS)).toMatchObject({ current_amount_cents: 9_000, last_actor: 'seller', status: 'open' });
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('ACTION-49DA06B7508F a %s cannot accept or counter, and nothing changes', async (role) => {
    signInAs(role);
    seedThreadsFor(role);
    const before = snapshot();
    expect(await respondToOfferAction({ negotiationId: THREAD_A_BUYS, action: 'accept' })).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(await respondToOfferAction({ negotiationId: THREAD_A_SELLS, action: 'counter', amountCents: 9_000 })).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(snapshot()).toEqual(before);
    expect(db.table('marketplace_orders')).toEqual([]);
    expect(harness.rpcCalls).toEqual([]);
  });

  it.each(ROLES)('ACTION-49DA06B7508F a %s who made the offer may withdraw it, and only that thread ends', async (role) => {
    signInAs(role);
    seedThreadsFor(role);
    expect(await respondToOfferAction({ negotiationId: THREAD_A_BUYS, action: 'withdraw' })).toEqual({ ok: true, data: { status: 'withdrawn', orderId: undefined } });
    expect(threadRow(THREAD_A_BUYS)?.status).toBe('withdrawn');
    expect(threadRow(THREAD_A_SELLS)?.status).toBe('open');
    expect(threadRow(THREAD_B_AND_C)?.status).toBe('open');
    expect(db.table('marketplace_orders')).toEqual([]);
  });

  it.each(ROLES)('ACTION-49DA06B7508F a %s who listed the item may decline an offer on it', async (role) => {
    signInAs(role);
    seedThreadsFor(role);
    expect(await respondToOfferAction({ negotiationId: THREAD_A_SELLS, action: 'decline' })).toEqual({ ok: true, data: { status: 'declined', orderId: undefined } });
    expect(threadRow(THREAD_A_SELLS)?.status).toBe('declined');
    expect(threadRow(THREAD_A_BUYS)?.status).toBe('open');
    expect(db.table('marketplace_orders')).toEqual([]);
  });

  it('ACTION-49DA06B7508F a signed-out caller is sent away and nothing changes', async () => {
    harness.ctx = null;
    const before = snapshot();
    await expect(respondToOfferAction({ negotiationId: THREAD_B_AND_C, action: 'decline' })).rejects.toThrow(/NEXT_REDIRECT/);
    expect(snapshot()).toEqual(before);
    expect(harness.rpcCalls).toEqual([]);
  });
});

describe('respondToOfferAction across households', () => {
  it.each(['accept', 'counter'] as const)(
    'ACTION-49DA06B7508F a parent of A who tries to %s on a thread between B and C is "not part of it", and is not told C closed',
    async (action) => {
      signInAs('parent');
      const before = snapshot();
      const res = await respondToOfferAction({ negotiationId: THREAD_B_AND_C, action, amountCents: 9_000 });
      expect(res).toEqual({ ok: false, error: NOT_PART_OF });
      expect(snapshot()).toEqual(before);
      expect(db.table('marketplace_orders')).toEqual([]);
    },
  );

  it.each(['decline', 'withdraw'] as const)('ACTION-49DA06B7508F a parent of A who tries to %s on a thread between B and C is refused, and nothing in B or C changes', async (action) => {
    signInAs('parent');
    const before = snapshot();
    expect(await respondToOfferAction({ negotiationId: THREAD_B_AND_C, action })).toEqual({ ok: false, error: NOT_PART_OF });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-49DA06B7508F the seller may not withdraw the buyer\'s offer, and the buyer may not decline the seller\'s counter', async () => {
    signInAs('parent');
    seedThreadsFor('parent');
    const before = snapshot();
    expect(await respondToOfferAction({ negotiationId: THREAD_A_SELLS, action: 'withdraw' })).toEqual({ ok: false, error: t('actions.onlyTheBuyerCanWithdraw') });
    expect(await respondToOfferAction({ negotiationId: THREAD_A_BUYS, action: 'decline' })).toEqual({ ok: false, error: t('actions.onlyTheSellerCanDecline') });
    expect(snapshot()).toEqual(before);
  });

  it.each(['accept', 'counter'] as const)('ACTION-49DA06B7508F a parent of A cannot %s with a seller household that closed', async (action) => {
    signInAs('parent');
    seedThreadsFor('parent');
    const before = snapshot();
    expect(await respondToOfferAction({ negotiationId: THREAD_A_BUYS_FROM_CLOSED, action, amountCents: 9_000 })).toEqual({ ok: false, error: CLOSED });
    expect(snapshot()).toEqual(before);
    expect(harness.rpcCalls).toEqual([]);
  });

  it('ACTION-49DA06B7508F a parent of A selling cannot accept a buyer household that closed', async () => {
    signInAs('parent');
    seedThreadsFor('parent');
    const before = snapshot();
    expect(await respondToOfferAction({ negotiationId: THREAD_A_SELLS_TO_CLOSED, action: 'accept' })).toEqual({ ok: false, error: CLOSED });
    expect(snapshot()).toEqual(before);
    expect(harness.rpcCalls).toEqual([]);
  });
});
