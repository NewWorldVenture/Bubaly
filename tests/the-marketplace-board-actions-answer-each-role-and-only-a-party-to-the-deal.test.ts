// Call-level role tests for the seven actions in app/(app)/marketplace/actions.ts
// (Register B, group 7). Each action is driven through the real export with
// valid input, as every role of household A, and with ids that belong to
// another household, and the tables are read back afterwards.
//
// The policy the cases pin, from the sources rather than from the action:
//   - The Marketplace is free and in every member's navigation
//     (lib/constants/navigation.ts:173, minLevel 0, no `manage`), and it is not
//     withheld from a guest (lib/auth/guest-scope.ts).
//   - A guest views the household (lib/constants/roles.ts ROLE_DESCRIPTIONS):
//     opening a storefront, reaching out about a listing and rating an exchange
//     act in the family's name, so the action refuses a guest those three (its
//     own comment at isGuest) and the item page does not offer them
//     (app/(app)/marketplace/item/[id]/page.tsx:75 canAct).
//   - Saves, follows and stores are per-member rows (0154's insert policies:
//     member_id = marketplace_member_id(family_id)); a save's listing must be
//     one the family can see (0462's restrictive insert policy).
//   - An order is read and stepped by its two parties, each from their own
//     household (0483 marketplace_orders_select/update); returned and
//     completed are the seller's (lib/marketplace/order-lifecycle.ts).
//   - A review needs a completed order of the review's own family, written by
//     one of its parties (0359 marketplace_reviews_insert).
//   - An interest offer is the in-family flow: its listing is in the offer's
//     own family (0462, reference_shares_family on marketplace_offers).
//
// Cross-family here means a household acting on a match, listing, order or
// store row it is not a party to. A buyer from another household acting on
// its own order is the normal case and is pinned as allowed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';

const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  memberId: '',
  userId: '',
  email: '',
  signedOut: false,
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    // A signed-out caller is sent to /login before any action body runs.
    if (harness.signedOut) throw new Error('NEXT_REDIRECT:/login');
    return {
      user: { id: harness.userId, email: harness.email },
      memberships: [],
      active: {
        familyId: FAMILY_A,
        role: harness.role,
        member: { id: harness.memberId, family_id: FAMILY_A },
        family: { id: FAMILY_A, timezone: 'UTC' },
      },
    };
  },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const {
  setMatchStatusAction, toggleSaveAction, toggleFollowAction, upsertStoreAction,
  setOrderStatusAction, leaveReviewAction, makeOfferAction,
} = await import('@/app/(app)/marketplace/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

// ── Two households (and a third, for an order A is not a party to) ─────────
const FAMILY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const FAMILY_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const FAMILY_C = '0c0c0c0c-0000-4000-8000-00000000000c';

type Caller = 'parent' | 'adult' | 'teen' | 'child' | 'kid' | 'caregiver' | 'guest';
const MEMBER_OF_A: Record<Caller, string> = {
  parent: 'a0000000-0000-4000-8000-000000000001',
  adult: 'a0000000-0000-4000-8000-000000000002',
  teen: 'a0000000-0000-4000-8000-000000000003',
  child: 'a0000000-0000-4000-8000-000000000004',
  kid: 'a0000000-0000-4000-8000-000000000005',
  caregiver: 'a0000000-0000-4000-8000-000000000006',
  guest: 'a0000000-0000-4000-8000-000000000007',
};
/** Another member of A: the sibling whose listing and store the callers act on. */
const A_SELLER = 'a0000000-0000-4000-8000-000000000009';
const B_MEMBER = 'b0000000-0000-4000-8000-000000000001';
const C_MEMBER = 'c0000000-0000-4000-8000-000000000001';

const LISTING_A = 'aaaa0000-0000-4000-8000-0000000000a1';
const LISTING_B = 'bbbb0000-0000-4000-8000-0000000000b1';
const MATCH_A = 'aaaa0000-0000-4000-8000-0000000000a2';
const MATCH_B = 'bbbb0000-0000-4000-8000-0000000000b2';
const STORE_A = 'aaaa0000-0000-4000-8000-0000000000a3';
const STORE_B = 'bbbb0000-0000-4000-8000-0000000000b3';
const ORDER = 'dddd0000-0000-4000-8000-0000000000d1';

const NON_GUESTS = ['parent', 'adult', 'teen', 'child', 'kid', 'caregiver'] as const;
const EVERY_ROLE = [...NON_GUESTS, 'guest'] as const;

function signInAs(caller: Caller) {
  harness.signedOut = false;
  // A kid login is a child member signed in with the kid PIN's address.
  harness.role = caller === 'kid' ? 'child' : caller;
  harness.memberId = MEMBER_OF_A[caller];
  harness.userId = `user-${caller}`;
  harness.email = caller === 'kid' ? `kid-a@${CHILD_LOGIN_EMAIL_DOMAIN}` : `${caller}@example.com`;
}

let db: InMemorySupabase;

const TABLES = [
  'marketplace_matches', 'marketplace_saves', 'marketplace_follows', 'marketplace_stores',
  'marketplace_orders', 'marketplace_reviews', 'marketplace_offers', 'marketplace_listings', 'marketplace_handoffs',
];
const everything = () => structuredClone(Object.fromEntries(TABLES.map((name) => [name, db.table(name)])));
const rowsOf = (table: string, family: string) => db.table(table).filter((r) => r.family_id === family);

beforeEach(() => {
  revalidatePath.mockReset();
  db = createInMemorySupabase({
    uniques: {
      marketplace_saves: [['listing_id', 'member_id']],
      marketplace_follows: [['store_id', 'member_id']],
      marketplace_stores: [['family_id', 'member_id']],
      marketplace_reviews: [['order_id', 'reviewer_member']],
    },
  });
  harness.db = db;
  db.seed('families', [
    { id: FAMILY_A, closed_at: null }, { id: FAMILY_B, closed_at: null }, { id: FAMILY_C, closed_at: null },
  ]);
  db.seed('marketplace_listings', [
    { id: LISTING_A, family_id: FAMILY_A, member_id: A_SELLER, kind: 'sell', status: 'available', sale_format: 'fixed', price_cents: 1500 },
    { id: LISTING_B, family_id: FAMILY_B, member_id: B_MEMBER, kind: 'sell', status: 'available', sale_format: 'fixed', price_cents: 2000 },
  ]);
  db.seed('marketplace_matches', [
    { id: MATCH_A, family_id: FAMILY_A, wanted_id: LISTING_A, supply_id: LISTING_A, status: 'active' },
    { id: MATCH_B, family_id: FAMILY_B, wanted_id: LISTING_B, supply_id: LISTING_B, status: 'active' },
  ]);
  db.seed('marketplace_stores', [
    { id: STORE_A, family_id: FAMILY_A, member_id: A_SELLER, name: 'Sibling shelf', is_active: true },
    { id: STORE_B, family_id: FAMILY_B, member_id: B_MEMBER, name: 'Rivera corner', is_active: true },
  ]);
  // Other people's saves and follows of the same listing and store, in A and in B.
  db.seed('marketplace_saves', [
    { id: 'aaaa0000-0000-4000-8000-0000000000a4', family_id: FAMILY_A, listing_id: LISTING_A, member_id: A_SELLER },
    { id: 'bbbb0000-0000-4000-8000-0000000000b4', family_id: FAMILY_B, listing_id: LISTING_A, member_id: B_MEMBER },
  ]);
  db.seed('marketplace_follows', [
    { id: 'aaaa0000-0000-4000-8000-0000000000a5', family_id: FAMILY_A, store_id: STORE_A, member_id: A_SELLER },
    { id: 'bbbb0000-0000-4000-8000-0000000000b5', family_id: FAMILY_B, store_id: STORE_A, member_id: B_MEMBER },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const seedOrder = (row: Record<string, unknown>) => db.seed('marketplace_orders', [{
  id: ORDER, listing_id: LISTING_A, kind: 'sell', amount_cents: 1500, buyer_family_id: null, ...row,
}]);
const theOrder = () => db.table('marketplace_orders').find((r) => r.id === ORDER);

// ── setMatchStatusAction ───────────────────────────────────────────────────
describe('setMatchStatusAction', () => {
  // The guest is not pinned here: see the PR's "Needs an owner decision".
  it.each(NON_GUESTS)('ACTION-E8ECFA5EC29B a %s of household A dismisses, then actions, its own match', async (caller) => {
    signInAs(caller);
    expect(await setMatchStatusAction(MATCH_A, 'dismissed')).toEqual({ ok: true });
    expect(db.table('marketplace_matches').map((r) => [r.id, r.status])).toEqual([[MATCH_A, 'dismissed'], [MATCH_B, 'active']]);
    expect(await setMatchStatusAction(MATCH_A, 'actioned')).toEqual({ ok: true });
    expect(db.table('marketplace_matches').map((r) => [r.id, r.status])).toEqual([[MATCH_A, 'actioned'], [MATCH_B, 'active']]);
    expect(revalidatePath).toHaveBeenCalledWith('/marketplace');
  });

  it("ACTION-E8ECFA5EC29B a parent of household A cannot touch household B's match", async () => {
    signInAs('parent');
    const before = everything();
    expect(await setMatchStatusAction(MATCH_B, 'dismissed')).toEqual({ ok: false, error: t('marketplace.couldNotUpdateTheMatch') });
    expect(everything()).toEqual(before);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// ── toggleSaveAction ───────────────────────────────────────────────────────
describe('toggleSaveAction', () => {
  it.each(EVERY_ROLE)("ACTION-17DECF058BEA a %s saves and unsaves only their own heart, leaving the sibling's and household B's", async (caller) => {
    signInAs(caller);
    const others = structuredClone(db.table('marketplace_saves'));

    expect(await toggleSaveAction(LISTING_A)).toEqual({ ok: true, saved: true });
    const mine = db.table('marketplace_saves').filter((r) => r.member_id === MEMBER_OF_A[caller]);
    expect(mine.map(({ family_id, listing_id, member_id }) => ({ family_id, listing_id, member_id })))
      .toEqual([{ family_id: FAMILY_A, listing_id: LISTING_A, member_id: MEMBER_OF_A[caller] }]);
    expect(db.table('marketplace_saves').filter((r) => r.member_id !== MEMBER_OF_A[caller])).toEqual(others);

    expect(await toggleSaveAction(LISTING_A)).toEqual({ ok: true, saved: false });
    expect(db.table('marketplace_saves')).toEqual(others);
  });

  it("ACTION-17DECF058BEA a save of household B's unshared listing that the database refuses is reported, and nothing is written", async () => {
    // 0462's restrictive insert policy refuses a save of a listing the family
    // cannot see; the action has to say so rather than report a heart.
    signInAs('teen');
    harness.db = withFaults(db, (table, calls) => (table === 'marketplace_saves' && calls.some((c) => c.method === 'insert')
      ? { code: '42501', message: 'new row violates row-level security policy for table "marketplace_saves"' } : null));
    const before = everything();
    const result = await toggleSaveAction(LISTING_B);
    expect(result.ok).toBe(false);
    expect(everything()).toEqual(before);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// ── toggleFollowAction ─────────────────────────────────────────────────────
describe('toggleFollowAction', () => {
  it.each(EVERY_ROLE)("ACTION-F7EB4A9FE45E a %s follows and unfollows only for themselves, leaving the sibling's and household B's follows", async (caller) => {
    signInAs(caller);
    const others = structuredClone(db.table('marketplace_follows'));

    expect(await toggleFollowAction(STORE_A)).toEqual({ ok: true, following: true });
    const mine = db.table('marketplace_follows').filter((r) => r.member_id === MEMBER_OF_A[caller]);
    expect(mine.map(({ family_id, store_id, member_id }) => ({ family_id, store_id, member_id })))
      .toEqual([{ family_id: FAMILY_A, store_id: STORE_A, member_id: MEMBER_OF_A[caller] }]);
    expect(db.table('marketplace_follows').filter((r) => r.member_id !== MEMBER_OF_A[caller])).toEqual(others);

    expect(await toggleFollowAction(STORE_A)).toEqual({ ok: true, following: false });
    expect(db.table('marketplace_follows')).toEqual(others);
  });
});

// ── upsertStoreAction ──────────────────────────────────────────────────────
describe('upsertStoreAction', () => {
  it.each(NON_GUESTS)('ACTION-D1655FF5DACD a %s opens, then renames, their own storefront and no one else\'s', async (caller) => {
    signInAs(caller);
    const others = structuredClone(db.table('marketplace_stores'));

    expect(await upsertStoreAction({ name: '  Lemonade stand ', tagline: 'Cold', description: '', emoji: '🍋' })).toEqual({ ok: true });
    expect(await upsertStoreAction({ name: 'Lemonade and cookies' })).toEqual({ ok: true });

    const mine = db.table('marketplace_stores').filter((r) => r.member_id === MEMBER_OF_A[caller]);
    expect(mine.map(({ family_id, member_id, name, tagline, description, emoji, is_active, created_by }) =>
      ({ family_id, member_id, name, tagline, description, emoji, is_active, created_by }))).toEqual([{
      family_id: FAMILY_A, member_id: MEMBER_OF_A[caller], name: 'Lemonade and cookies',
      tagline: null, description: null, emoji: null, is_active: true, created_by: `user-${caller}`,
    }]);
    expect(db.table('marketplace_stores').filter((r) => r.member_id !== MEMBER_OF_A[caller])).toEqual(others);
  });

  it('ACTION-D1655FF5DACD a guest of household A is refused a storefront, and none is written', async () => {
    signInAs('guest');
    const before = everything();
    expect(await upsertStoreAction({ name: 'Grandma bakes' })).toEqual({ ok: false, error: t('actionRefusal.notAllowed') });
    expect(everything()).toEqual(before);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// ── setOrderStatusAction ───────────────────────────────────────────────────
describe('setOrderStatusAction', () => {
  // The guest is not pinned here: see the PR's "Needs an owner decision".
  it.each(NON_GUESTS)('ACTION-A21306398A80 a %s who sold to household B takes the order from requested to completed', async (caller) => {
    signInAs(caller);
    seedOrder({ family_id: FAMILY_A, buyer_family_id: FAMILY_B, seller_member: MEMBER_OF_A[caller], buyer_member: B_MEMBER, status: 'requested' });
    for (const step of ['confirmed', 'active', 'completed']) {
      expect(await setOrderStatusAction(ORDER, step), step).toEqual({ ok: true });
      expect(theOrder()?.status).toBe(step);
    }
    expect(revalidatePath).toHaveBeenCalledWith('/marketplace/orders');
  });

  it.each(NON_GUESTS)('ACTION-A21306398A80 a %s who is buying from household B may cancel, and may not complete, the order', async (caller) => {
    signInAs(caller);
    seedOrder({ family_id: FAMILY_B, buyer_family_id: FAMILY_A, seller_member: B_MEMBER, buyer_member: MEMBER_OF_A[caller], status: 'active' });
    expect(await setOrderStatusAction(ORDER, 'completed')).toEqual({ ok: false, error: t('marketplace.onlyTheSellerFinishesAnOrder') });
    expect(theOrder()?.status).toBe('active');

    theOrder()!.status = 'confirmed';
    expect(await setOrderStatusAction(ORDER, 'cancelled')).toEqual({ ok: true });
    expect(theOrder()?.status).toBe('cancelled');
  });

  it('ACTION-A21306398A80 a parent of household A cannot step an order between households B and C', async () => {
    signInAs('parent');
    seedOrder({ family_id: FAMILY_B, buyer_family_id: FAMILY_C, seller_member: B_MEMBER, buyer_member: C_MEMBER, status: 'requested' });
    const before = everything();
    for (const step of ['confirmed', 'cancelled']) {
      expect(await setOrderStatusAction(ORDER, step), step).toEqual({ ok: false, error: t('actions.orderNotFound') });
    }
    expect(everything()).toEqual(before);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// ── leaveReviewAction ──────────────────────────────────────────────────────
describe('leaveReviewAction', () => {
  it.each(NON_GUESTS)('ACTION-AADABAD791D2 a %s who sold within household A reviews the buyer once', async (caller) => {
    signInAs(caller);
    seedOrder({ family_id: FAMILY_A, seller_member: MEMBER_OF_A[caller], buyer_member: A_SELLER, status: 'completed' });
    expect(await leaveReviewAction({ orderId: ORDER, rating: 4.6, comment: ' Smooth exchange ' })).toEqual({ ok: true });
    expect(db.table('marketplace_reviews').map(({ id: _id, created_at: _c, updated_at: _u, ...rest }) => rest)).toEqual([{
      family_id: FAMILY_A, order_id: ORDER, listing_id: LISTING_A, reviewer_member: MEMBER_OF_A[caller],
      reviewee_member: A_SELLER, role: 'seller', rating: 5, comment: 'Smooth exchange', created_by: `user-${caller}`,
    }]);

    expect(await leaveReviewAction({ orderId: ORDER, rating: 2 })).toEqual({ ok: false, error: t('actions.youAlreadyReviewedThisExchange') });
    expect(db.table('marketplace_reviews')).toHaveLength(1);
  });

  it('ACTION-AADABAD791D2 a guest who is a party to a completed order is refused, and no review is written', async () => {
    signInAs('guest');
    seedOrder({ family_id: FAMILY_A, seller_member: A_SELLER, buyer_member: MEMBER_OF_A.guest, status: 'completed' });
    expect(await leaveReviewAction({ orderId: ORDER, rating: 5 })).toEqual({ ok: false, error: t('actionRefusal.notAllowed') });
    expect(db.table('marketplace_reviews')).toEqual([]);
  });

  it.each(NON_GUESTS)("ACTION-AADABAD791D2 a %s cannot review a household A order they were not a party to", async (caller) => {
    signInAs(caller);
    seedOrder({ family_id: FAMILY_A, seller_member: A_SELLER, buyer_member: MEMBER_OF_A.guest, status: 'completed' });
    expect(await leaveReviewAction({ orderId: ORDER, rating: 1 })).toEqual({ ok: false, error: t('actions.onlyTheTwoPartiesCan') });
    expect(db.table('marketplace_reviews')).toEqual([]);
  });

  it('ACTION-AADABAD791D2 a parent cannot review an exchange that is not finished', async () => {
    signInAs('parent');
    seedOrder({ family_id: FAMILY_A, seller_member: MEMBER_OF_A.parent, buyer_member: A_SELLER, status: 'active' });
    expect(await leaveReviewAction({ orderId: ORDER, rating: 5 })).toEqual({ ok: false, error: t('actions.reviewsOpenOnceTheExchange') });
    expect(db.table('marketplace_reviews')).toEqual([]);
  });

  it('ACTION-AADABAD791D2 a parent of household A cannot review an order between households B and C', async () => {
    signInAs('parent');
    seedOrder({ family_id: FAMILY_B, buyer_family_id: FAMILY_C, seller_member: B_MEMBER, buyer_member: C_MEMBER, status: 'completed' });
    const before = everything();
    expect(await leaveReviewAction({ orderId: ORDER, rating: 1 })).toEqual({ ok: false, error: t('actions.orderNotFound') });
    expect(everything()).toEqual(before);
  });

  it("ACTION-AADABAD791D2 household A's buyer of household B's item is told reviews across households are not open, and nothing is written", async () => {
    signInAs('parent');
    seedOrder({ family_id: FAMILY_B, buyer_family_id: FAMILY_A, seller_member: B_MEMBER, buyer_member: MEMBER_OF_A.parent, status: 'completed' });
    const before = everything();
    expect(await leaveReviewAction({ orderId: ORDER, rating: 5 }))
      .toEqual({ ok: false, error: t('marketplace.reviewsAcrossHouseholdsAreNotOpenYet') });
    expect(everything()).toEqual(before);
  });
});

// ── makeOfferAction ────────────────────────────────────────────────────────
describe('makeOfferAction', () => {
  it.each(NON_GUESTS)("ACTION-AE9AAC2E62DB a %s reaches out about a sibling's listing at its price, once", async (caller) => {
    signInAs(caller);
    expect(await makeOfferAction(LISTING_A)).toEqual({ ok: true });
    expect(db.table('marketplace_offers').map(({ family_id, listing_id, member_id, kind, amount_cents, created_by }) =>
      ({ family_id, listing_id, member_id, kind, amount_cents, created_by }))).toEqual([{
      family_id: FAMILY_A, listing_id: LISTING_A, member_id: MEMBER_OF_A[caller], kind: 'interest', amount_cents: 1500, created_by: `user-${caller}`,
    }]);
    db.table('marketplace_offers')[0].status = 'open';
    expect(await makeOfferAction(LISTING_A)).toEqual({ ok: false, error: t('actions.youAlreadyReachedOutAbout') });
    expect(db.table('marketplace_offers')).toHaveLength(1);
  });

  it('ACTION-AE9AAC2E62DB a guest of household A is refused, and no offer is written', async () => {
    signInAs('guest');
    const before = everything();
    expect(await makeOfferAction(LISTING_A)).toEqual({ ok: false, error: t('actionRefusal.notAllowed') });
    expect(everything()).toEqual(before);
  });

  it('ACTION-AE9AAC2E62DB a member cannot reach out about their own listing', async () => {
    signInAs('teen');
    db.table('marketplace_listings')[0].member_id = MEMBER_OF_A.teen;
    expect(await makeOfferAction(LISTING_A)).toEqual({ ok: false, error: t('actions.thisIsYourOwnListing') });
    expect(db.table('marketplace_offers')).toEqual([]);
  });

  it("ACTION-AE9AAC2E62DB a parent of household A gets not found for household B's listing, and neither household changes", async () => {
    signInAs('parent');
    const before = everything();
    expect(await makeOfferAction(LISTING_B)).toEqual({ ok: false, error: t('actions.listingNotFound') });
    expect(everything()).toEqual(before);
    expect(rowsOf('marketplace_offers', FAMILY_B)).toEqual([]);
  });
});

// ── A signed-out caller ────────────────────────────────────────────────────
describe('a signed-out caller', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['ACTION-E8ECFA5EC29B setMatchStatusAction', () => setMatchStatusAction(MATCH_A, 'dismissed')],
    ['ACTION-17DECF058BEA toggleSaveAction', () => toggleSaveAction(LISTING_A)],
    ['ACTION-F7EB4A9FE45E toggleFollowAction', () => toggleFollowAction(STORE_A)],
    ['ACTION-D1655FF5DACD upsertStoreAction', () => upsertStoreAction({ name: 'Anonymous' })],
    ['ACTION-A21306398A80 setOrderStatusAction', () => setOrderStatusAction(ORDER, 'confirmed')],
    ['ACTION-AADABAD791D2 leaveReviewAction', () => leaveReviewAction({ orderId: ORDER, rating: 5 })],
    ['ACTION-AE9AAC2E62DB makeOfferAction', () => makeOfferAction(LISTING_A)],
  ];
  it.each(calls)('%s is sent to sign in and writes nothing', async (_name, call) => {
    seedOrder({ family_id: FAMILY_A, seller_member: A_SELLER, buyer_member: MEMBER_OF_A.parent, status: 'requested' });
    harness.signedOut = true;
    const before = everything();
    await expect(call()).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(everything()).toEqual(before);
  });
});
