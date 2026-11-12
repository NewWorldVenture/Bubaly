import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * Call-level role tests for the four pickup actions
 * (app/(app)/marketplace/handoff/actions.ts), driven with valid input for every
 * role of household A, and with ids from deals household C is not a party to.
 *
 * The policy these pin, from the sources rather than the action:
 *  - Only the two people in the exchange act on its pickup (the action's
 *    loadOrderRole; 0483's mkt_handoff_* policies, is_marketplace_order_party,
 *    and marketplace_complete_handoff's party check). Any role may be a party:
 *    the Orders page renders the HandoffPanel to the buyer or the seller
 *    whatever their role, the marketplace is free (navigation.ts minLevel 0)
 *    and not withheld from a guest (lib/auth/guest-scope.ts).
 *  - A deal BETWEEN households: only a parent or adult (isManager,
 *    lib/constants/roles.ts) proposes or confirms the meeting
 *    (minorMeetingOutsider). Within one family a teen, child, caregiver or
 *    guest arranges a pickup with a sibling as before.
 *  - Cancelling is "either party" (the action's own docstring); RLS asks for a
 *    party and nothing else, so a minor may call a meeting off.
 *  - A household that is neither the seller's nor the buyer's does not find
 *    the order at all (readFamilyOrders' either-family filter, 0483's
 *    marketplace_orders_select).
 *
 * Not pinned here (owner decision): a non-manager who is the PROPOSER of a
 * confirmed pickup in a deal with another household completing it. The app
 * cannot reach that state any more (proposing is refused), and no source says
 * whether completing is "arranging the meeting".
 */
const FAMILY_A = 'a0a0a0a0-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
const FAMILY_C = 'c0c0c0c0-0000-4000-8000-00000000000c';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Role = (typeof ROLES)[number];
const MINORS_AND_HELPERS = ['teen', 'child', 'caregiver', 'guest'] as const;
const MANAGERS = ['parent', 'adult'] as const;

const memberOfA: Record<Role, string> = {
  parent: 'a1a1a1a1-0000-4000-8000-000000000001',
  adult: 'a1a1a1a1-0000-4000-8000-000000000002',
  teen: 'a1a1a1a1-0000-4000-8000-000000000003',
  child: 'a1a1a1a1-0000-4000-8000-000000000004',
  caregiver: 'a1a1a1a1-0000-4000-8000-000000000005',
  guest: 'a1a1a1a1-0000-4000-8000-000000000006',
};
/** A's sibling on the other side of an in-family deal. */
const SIBLING_A = 'a1a1a1a1-0000-4000-8000-000000000007';
const BUYER_B = 'b1b1b1b1-0000-4000-8000-000000000001';
const OTHER_B = 'b1b1b1b1-0000-4000-8000-000000000002';
const PARENT_C = 'c1c1c1c1-0000-4000-8000-000000000001';

const ORDER = '0d0d0d0d-0000-4000-8000-000000000001';
const LISTING = '0e0e0e0e-0000-4000-8000-000000000001';
const HANDOFF = '0f0f0f0f-0000-4000-8000-000000000001';
const MEET_AT = '2026-11-20T17:00:00.000Z';
const CODE = 'K7M9PQ';

// The en-US sentences a reader sees, typed out.
const ORDER_NOT_FOUND = 'Order not found.';
const NOT_A_PARTY = 'You are not part of this marketplace exchange.';
const ADULTS_ONLY = 'Only a parent/guardian can do this.';
const WAIT_FOR_OTHER = 'Wait for the other person to confirm your proposal.';
const YOU_HOLD_THE_CODE = 'You hold the hand-off code: share it when you meet, and the other person enters it.';

const harness = vi.hoisted(() => ({
  db: null as unknown,
  familyId: '',
  memberId: '',
  role: 'parent',
  revalidatePath: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: harness.revalidatePath }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}`, email: 'member@example.com' },
    memberships: [],
    active: { familyId: harness.familyId, role: harness.role, member: { id: harness.memberId, family_id: harness.familyId } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const { proposeHandoffAction, confirmHandoffAction, cancelHandoffAction, completeHandoffAction } =
  await import('@/app/(app)/marketplace/handoff/actions');

const signIn = (familyId: string, memberId: string, role: string) => {
  harness.familyId = familyId;
  harness.memberId = memberId;
  harness.role = role;
};

/**
 * marketplace_complete_handoff as 0483 wrote it: the caller must BE the buyer
 * or the seller, the order open, the pickup confirmed and the code the stored
 * one; then the pickup and the order complete together.
 */
function completeRpc(args: Record<string, unknown>, mem: InMemorySupabase) {
  const order = mem.table('marketplace_orders').find((o) => o.id === args.p_order_id);
  if (!order) return { ok: false, reason: 'order_not_found' };
  if (![order.buyer_member, order.seller_member].includes(harness.memberId)) return { ok: false, reason: 'forbidden' };
  if (!['confirmed', 'active', 'returned'].includes(String(order.status))) return { ok: false, reason: 'order_not_open' };
  const handoff = mem.table('marketplace_handoffs').find((h) => h.order_id === order.id);
  if (!handoff) return { ok: false, reason: 'handoff_not_found' };
  if (handoff.status !== 'confirmed') return { ok: false, reason: 'handoff_not_ready' };
  if (String(args.p_code).toUpperCase() !== handoff.confirm_code) return { ok: false, reason: 'code_mismatch' };
  Object.assign(handoff, { status: 'completed', completed_at: '2026-11-20T17:05:00.000Z' });
  order.status = 'completed';
  return { ok: true, status: 'completed' };
}

let db: InMemorySupabase;

type Deal = {
  seller: string; sellerFamily: string; buyer: string; buyerFamily: string;
  kind?: string; handoff?: Partial<Row> | null;
};

/** One order and its pickup (a proposal by the buyer unless `handoff` says otherwise; `null` for none), the row family_id being the order's (the seller's). */
function seedDeal(deal: Deal) {
  db.seed('marketplace_orders', [{
    id: ORDER, family_id: deal.sellerFamily,
    buyer_family_id: deal.buyerFamily === deal.sellerFamily ? null : deal.buyerFamily,
    listing_id: LISTING, buyer_member: deal.buyer, seller_member: deal.seller, kind: deal.kind ?? 'buy', status: 'confirmed',
  }]);
  if (deal.handoff !== null) {
    db.seed('marketplace_handoffs', [{
      id: HANDOFF, order_id: ORDER, family_id: deal.sellerFamily, listing_id: LISTING,
      proposed_by: deal.buyer, proposer_role: 'buyer', status: 'proposed', meet_at: MEET_AT,
      location_label: 'Public library', location_kind: 'public_spot', confirm_code: null,
      confirmed_at: null, completed_at: null, calendar_event_id: null, notes: null,
      ...(deal.handoff ?? {}),
    }]);
  }
}

/** A sells to a household B member: the deal between two families. */
const acrossFamilies = (role: Role, handoff?: Partial<Row> | null, kind?: string) =>
  seedDeal({ seller: memberOfA[role], sellerFamily: FAMILY_A, buyer: BUYER_B, buyerFamily: FAMILY_B, handoff, kind });
/** A sells to a sibling in A. */
const withinFamily = (role: Role, handoff?: Partial<Row> | null) =>
  seedDeal({ seller: memberOfA[role], sellerFamily: FAMILY_A, buyer: SIBLING_A, buyerFamily: FAMILY_A, handoff });

/** Everything a pickup action could touch. */
const everything = () => structuredClone({
  handoffs: db.table('marketplace_handoffs'),
  orders: db.table('marketplace_orders'),
  calendar: db.table('calendar_events'),
});

const handoff = () => db.table('marketplace_handoffs').find((h) => h.id === HANDOFF || h.order_id === ORDER);
const pickupEvents = (familyId: string) => db.table('calendar_events')
  .filter((e) => e.family_id === familyId && String(e.title).startsWith('Marketplace pickup'));

beforeEach(() => {
  harness.revalidatePath.mockReset();
  db = createInMemorySupabase({
    rpc: { marketplace_complete_handoff: completeRpc },
    uniques: { marketplace_handoffs: [['order_id']] },
  });
  harness.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.seed('family_members', [
    ...ROLES.map((role) => ({ id: memberOfA[role], family_id: FAMILY_A, role, is_active: true })),
    { id: SIBLING_A, family_id: FAMILY_A, role: 'teen', is_active: true },
    { id: BUYER_B, family_id: FAMILY_B, role: 'parent', is_active: true },
    { id: OTHER_B, family_id: FAMILY_B, role: 'parent', is_active: true },
    { id: PARENT_C, family_id: FAMILY_C, role: 'parent', is_active: true },
  ]);
  // Each household's own calendar, so a cross-family write would show.
  db.seed('calendar_events', [
    { id: 'e0e0e0e0-0000-4000-8000-00000000000a', family_id: FAMILY_A, title: 'Swim practice', starts_at: MEET_AT },
    { id: 'e0e0e0e0-0000-4000-8000-00000000000b', family_id: FAMILY_B, title: 'Dentist', starts_at: MEET_AT },
  ]);
});

// ── proposeHandoffAction ────────────────────────────────────────────────────
describe('proposeHandoffAction', () => {
  const propose = () => proposeHandoffAction({ orderId: ORDER, meetAtIso: MEET_AT, locationLabel: '  Coffee shop  ', notes: ' Blue jacket ' });

  it.each(MANAGERS)('ACTION-775FF1987E61 a %s of A, the seller in a deal with household B, proposes the pickup', async (role) => {
    acrossFamilies(role, null);
    signIn(FAMILY_A, memberOfA[role], role);

    expect(await propose()).toEqual({ ok: true });
    expect(db.table('marketplace_handoffs')).toHaveLength(1);
    expect(handoff()).toMatchObject({
      order_id: ORDER, family_id: FAMILY_A, listing_id: LISTING, proposed_by: memberOfA[role], proposer_role: 'seller',
      meet_at: MEET_AT, location_label: 'Coffee shop', location_kind: 'public_spot', status: 'proposed',
      confirm_code: null, notes: 'Blue jacket',
    });
    expect(harness.revalidatePath).toHaveBeenCalledWith('/marketplace/orders');
  });

  it.each(MINORS_AND_HELPERS)('ACTION-775FF1987E61 a %s of A, the seller in a deal with household B, is refused and nothing is written', async (role) => {
    acrossFamilies(role, null);
    signIn(FAMILY_A, memberOfA[role], role);
    const before = everything();

    expect(await propose()).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(everything()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(ROLES)('ACTION-775FF1987E61 a %s of A proposes a pickup with a sibling in A', async (role) => {
    withinFamily(role, null);
    signIn(FAMILY_A, memberOfA[role], role);

    expect(await propose()).toEqual({ ok: true });
    expect(db.table('marketplace_handoffs')).toHaveLength(1);
    expect(handoff()).toMatchObject({ proposed_by: memberOfA[role], proposer_role: 'seller', status: 'proposed', location_label: 'Coffee shop' });
  });

  it('ACTION-775FF1987E61 a parent of A who is not a party to an A–B deal is refused and nothing is written', async () => {
    acrossFamilies('teen', null);
    signIn(FAMILY_A, memberOfA.parent, 'parent');
    const before = everything();

    expect(await propose()).toEqual({ ok: false, error: NOT_A_PARTY });
    expect(everything()).toEqual(before);
  });

  it('ACTION-775FF1987E61 a parent of household C, given the A–B order id, does not find it and nothing changes', async () => {
    acrossFamilies('parent', { status: 'proposed' });
    signIn(FAMILY_C, PARENT_C, 'parent');
    const before = everything();

    expect(await propose()).toEqual({ ok: false, error: ORDER_NOT_FOUND });
    expect(everything()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});

// ── confirmHandoffAction ────────────────────────────────────────────────────
describe('confirmHandoffAction', () => {
  it.each(MANAGERS)('ACTION-F437CA8170C1 a %s of A confirms the pickup household B proposed: the code is stored and the event is on A’s calendar', async (role) => {
    acrossFamilies(role);
    signIn(FAMILY_A, memberOfA[role], role);

    const result = await confirmHandoffAction(ORDER, { meetAt: MEET_AT, locationLabel: 'Public library' });
    expect(result.ok).toBe(true);
    const stored = handoff();
    expect(stored).toMatchObject({ status: 'confirmed', family_id: FAMILY_A });
    expect(result).toEqual({ ok: true, data: { code: stored?.confirm_code } });
    expect(String(stored?.confirm_code)).toMatch(/^[A-Z2-9]{6}$/);
    const events = pickupEvents(FAMILY_A);
    expect(events).toHaveLength(1);
    expect(stored?.calendar_event_id).toBe(events[0].id);
    expect(pickupEvents(FAMILY_B)).toHaveLength(0);
  });

  it.each(MINORS_AND_HELPERS)('ACTION-F437CA8170C1 a %s of A, in a deal with household B, is refused: no code is minted and no event is made', async (role) => {
    acrossFamilies(role);
    signIn(FAMILY_A, memberOfA[role], role);
    const before = everything();

    expect(await confirmHandoffAction(ORDER)).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(everything()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(ROLES)('ACTION-F437CA8170C1 a %s of A confirms a pickup its sibling proposed', async (role) => {
    withinFamily(role, { proposed_by: SIBLING_A });
    signIn(FAMILY_A, memberOfA[role], role);

    const result = await confirmHandoffAction(ORDER);
    expect(handoff()).toMatchObject({ status: 'confirmed' });
    expect(result).toEqual({ ok: true, data: { code: handoff()?.confirm_code } });
    expect(pickupEvents(FAMILY_A)).toHaveLength(1);
  });

  it('ACTION-F437CA8170C1 the proposer cannot confirm their own proposal', async () => {
    acrossFamilies('parent', { proposed_by: memberOfA.parent, proposer_role: 'seller' });
    signIn(FAMILY_A, memberOfA.parent, 'parent');
    const before = everything();

    expect(await confirmHandoffAction(ORDER)).toEqual({ ok: false, error: WAIT_FOR_OTHER });
    expect(everything()).toEqual(before);
  });

  it('ACTION-F437CA8170C1 a parent of A who is not a party, and a B parent who is not the buyer, are refused', async () => {
    acrossFamilies('teen');
    const before = everything();

    signIn(FAMILY_A, memberOfA.parent, 'parent');
    expect(await confirmHandoffAction(ORDER)).toEqual({ ok: false, error: NOT_A_PARTY });
    signIn(FAMILY_B, OTHER_B, 'parent');
    expect(await confirmHandoffAction(ORDER)).toEqual({ ok: false, error: NOT_A_PARTY });
    expect(everything()).toEqual(before);
  });

  it('ACTION-F437CA8170C1 a parent of household C, given the A–B order id, does not find it: no code, no event anywhere', async () => {
    acrossFamilies('parent');
    signIn(FAMILY_C, PARENT_C, 'parent');
    const before = everything();

    expect(await confirmHandoffAction(ORDER)).toEqual({ ok: false, error: ORDER_NOT_FOUND });
    expect(everything()).toEqual(before);
  });
});

// ── cancelHandoffAction ─────────────────────────────────────────────────────
describe('cancelHandoffAction', () => {
  it.each(ROLES)('ACTION-ED88541ABEB4 a %s of A, a party to a deal with household B, calls the pickup off', async (role) => {
    acrossFamilies(role, { status: 'confirmed', confirm_code: CODE });
    signIn(FAMILY_A, memberOfA[role], role);
    const orderBefore = structuredClone(db.table('marketplace_orders'));

    expect(await cancelHandoffAction(ORDER)).toEqual({ ok: true });
    expect(handoff()).toMatchObject({ status: 'cancelled' });
    expect(db.table('marketplace_orders')).toEqual(orderBefore);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/marketplace/orders');
  });

  it.each(ROLES)('ACTION-ED88541ABEB4 a %s of A calls off a pickup with a sibling', async (role) => {
    withinFamily(role, { status: 'proposed' });
    signIn(FAMILY_A, memberOfA[role], role);

    expect(await cancelHandoffAction(ORDER)).toEqual({ ok: true });
    expect(handoff()).toMatchObject({ status: 'cancelled' });
  });

  it('ACTION-ED88541ABEB4 a parent of A who is not a party is refused and the pickup stands', async () => {
    acrossFamilies('teen', { status: 'confirmed', confirm_code: CODE });
    signIn(FAMILY_A, memberOfA.parent, 'parent');
    const before = everything();

    expect(await cancelHandoffAction(ORDER)).toEqual({ ok: false, error: NOT_A_PARTY });
    expect(everything()).toEqual(before);
  });

  it('ACTION-ED88541ABEB4 a parent of household C, given the A–B order id, does not find it and the pickup stands', async () => {
    acrossFamilies('parent', { status: 'confirmed', confirm_code: CODE });
    signIn(FAMILY_C, PARENT_C, 'parent');
    const before = everything();

    expect(await cancelHandoffAction(ORDER)).toEqual({ ok: false, error: ORDER_NOT_FOUND });
    expect(everything()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});

// ── completeHandoffAction ───────────────────────────────────────────────────
describe('completeHandoffAction', () => {
  /** A's member proposed; the other side confirmed and holds CODE. */
  const confirmedByOtherSide = { status: 'confirmed', confirm_code: CODE, proposer_role: 'seller' } as const;

  it.each(ROLES)('ACTION-1CEE0512C3B5 a %s of A, the proposer in a sale to a sibling, enters the code and the sale completes', async (role) => {
    withinFamily(role, { ...confirmedByOtherSide, proposed_by: memberOfA[role] });
    signIn(FAMILY_A, memberOfA[role], role);

    expect(await completeHandoffAction({ orderId: ORDER, code: CODE.toLowerCase() })).toEqual({ ok: true });
    expect(handoff()).toMatchObject({ status: 'completed' });
    expect(db.table('marketplace_orders')[0]).toMatchObject({ status: 'completed' });
    expect(harness.revalidatePath).toHaveBeenCalledWith('/marketplace/orders');
  });

  it.each(MANAGERS)('ACTION-1CEE0512C3B5 a %s of A, the proposer in a sale to household B, completes it', async (role) => {
    acrossFamilies(role, { ...confirmedByOtherSide, proposed_by: memberOfA[role] });
    signIn(FAMILY_A, memberOfA[role], role);

    expect(await completeHandoffAction({ orderId: ORDER, code: CODE })).toEqual({ ok: true });
    expect(handoff()).toMatchObject({ status: 'completed' });
    expect(db.table('marketplace_orders')[0]).toMatchObject({ status: 'completed' });
  });

  it.each(MANAGERS)('ACTION-1CEE0512C3B5 a %s of A, the proposer of a rent to household B, starts the loan at the pickup', async (role) => {
    acrossFamilies(role, { ...confirmedByOtherSide, proposed_by: memberOfA[role] }, 'rent');
    signIn(FAMILY_A, memberOfA[role], role);

    expect(await completeHandoffAction({ orderId: ORDER, code: CODE })).toEqual({ ok: true, data: { loanStarted: true } });
    expect(handoff()).toMatchObject({ status: 'completed' });
    expect(db.table('marketplace_orders')[0]).toMatchObject({ status: 'active' });
  });

  it('ACTION-1CEE0512C3B5 the confirmer, who holds the code, cannot complete alone', async () => {
    acrossFamilies('parent', { status: 'confirmed', confirm_code: CODE, proposer_role: 'buyer' });
    signIn(FAMILY_A, memberOfA.parent, 'parent');
    const before = everything();

    expect(await completeHandoffAction({ orderId: ORDER, code: CODE })).toEqual({ ok: false, error: YOU_HOLD_THE_CODE });
    expect(everything()).toEqual(before);
  });

  it('ACTION-1CEE0512C3B5 a parent of A who is not a party is refused with the right code, and the order stays open', async () => {
    acrossFamilies('teen', { ...confirmedByOtherSide, proposed_by: memberOfA.teen });
    signIn(FAMILY_A, memberOfA.parent, 'parent');
    const before = everything();

    expect(await completeHandoffAction({ orderId: ORDER, code: CODE })).toEqual({ ok: false, error: NOT_A_PARTY });
    expect(everything()).toEqual(before);
  });

  it('ACTION-1CEE0512C3B5 a parent of household C, given the A–B order id and its code, does not find it and nothing changes', async () => {
    acrossFamilies('parent', { ...confirmedByOtherSide, proposed_by: memberOfA.parent });
    signIn(FAMILY_C, PARENT_C, 'parent');
    const before = everything();

    expect(await completeHandoffAction({ orderId: ORDER, code: CODE })).toEqual({ ok: false, error: ORDER_NOT_FOUND });
    expect(everything()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});
