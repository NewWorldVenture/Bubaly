import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A marketplace pickup between two households: whose calendar it leaves.
 *
 * Confirming a pickup puts it on the CONFIRMER's family calendar
 * (`confirmHandoffAction`: the buyer's household cannot write the seller's
 * family calendar), and links the event on the pickup. Cancelling the pickup
 * (`cancelHandoffAction`) or the order (`setOrderStatusAction` →
 * `cancelOrderPickup`) removes that event with the canceller's own session,
 * from the canceller's own family.
 *
 * Owner coordinator finding AUD-1037-MARKETPLACE-BOUNDARIES: so when the
 * OTHER household confirmed, cancelling leaves their copy on their calendar,
 * and the cancel still answers success. That is kept, deliberately: the
 * canceller's session has no right to delete another family's calendar, and
 * the event id on the pickup row is writable by either party, so it is no
 * proof of which event a confirm made. An authorized cleanup needs a database
 * function that removes only the event the confirm recorded, which is SQL
 * held for the owner. Until then these controls pin the boundary: the
 * canceller's own copy goes, another family's event is never deleted by the
 * canceller, and the miss is logged rather than reported as removed.
 */
const harness = vi.hoisted(() => ({ db: null as unknown, familyId: 'family-s', memberId: 'member-s' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: harness.familyId, role: 'parent', member: { id: harness.memberId, family_id: harness.familyId } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const { confirmHandoffAction, cancelHandoffAction } = await import('@/app/(app)/marketplace/handoff/actions');
const { setOrderStatusAction } = await import('@/app/(app)/marketplace/actions');

const MEET_AT = '2026-10-12T15:00:00.000Z';
const SELLER = { familyId: 'family-s', memberId: 'member-s' };
const BUYER = { familyId: 'family-b', memberId: 'member-b' };
const as = (who: { familyId: string; memberId: string }) => { harness.familyId = who.familyId; harness.memberId = who.memberId; };

let db: InMemorySupabase;
beforeEach(() => {
  db = createInMemorySupabase();
  harness.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // An order between two households: it carries the seller's family, and the buyer's as buyer_family_id.
  db.seed('marketplace_orders', [{
    id: 'order-1', family_id: SELLER.familyId, buyer_family_id: BUYER.familyId, listing_id: 'listing-1',
    buyer_member: BUYER.memberId, seller_member: SELLER.memberId, kind: 'buy', status: 'confirmed',
  }]);
  db.seed('calendar_events', [
    { id: 'event-seller-swim', family_id: SELLER.familyId, title: 'Swim practice', starts_at: MEET_AT },
    { id: 'event-buyer-dentist', family_id: BUYER.familyId, title: 'Dentist', starts_at: MEET_AT },
  ]);
});

function proposedBy(role: 'seller' | 'buyer') {
  db.seed('marketplace_handoffs', [{
    id: 'handoff-1', order_id: 'order-1', family_id: SELLER.familyId, listing_id: 'listing-1',
    proposed_by: role === 'seller' ? SELLER.memberId : BUYER.memberId, proposer_role: role, status: 'proposed',
    location_label: 'Library', location_kind: 'public_spot', meet_at: MEET_AT, confirm_code: null, calendar_event_id: null,
  }]);
}

const pickupEvents = (familyId: string) => db.table('calendar_events')
  .filter((e) => e.family_id === familyId && String(e.title).startsWith('Marketplace pickup'));
const otherEvents = () => db.table('calendar_events').filter((e) => !String(e.title).startsWith('Marketplace pickup')).map((e) => e.id);
const stayedOnCalendar = () => expect(console.error).toHaveBeenCalledWith('[marketplace-handoff] the pickup stayed on the family calendar', expect.anything());

describe('a pickup the buyer confirmed', () => {
  beforeEach(async () => {
    proposedBy('seller');
    as(BUYER);
    expect((await confirmHandoffAction('order-1')).ok).toBe(true);
    expect(pickupEvents(BUYER.familyId)).toHaveLength(1);
    expect(pickupEvents(SELLER.familyId)).toHaveLength(0);
  });

  it('cancelled by the seller: the pickup is off, the buyer\'s copy is not the seller\'s to delete, and the miss is logged', async () => {
    as(SELLER);
    expect(await cancelHandoffAction('order-1')).toEqual({ ok: true });

    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'cancelled' });
    expect(pickupEvents(BUYER.familyId)).toHaveLength(1);
    expect(otherEvents()).toEqual(['event-seller-swim', 'event-buyer-dentist']);
    stayedOnCalendar();
  });

  it('with its order cancelled by the seller: the same', async () => {
    as(SELLER);
    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: true });

    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'cancelled' });
    expect(pickupEvents(BUYER.familyId)).toHaveLength(1);
    expect(otherEvents()).toEqual(['event-seller-swim', 'event-buyer-dentist']);
    stayedOnCalendar();
  });

  it('cancelled by the buyer who confirmed it: their own copy comes off', async () => {
    as(BUYER);
    expect(await cancelHandoffAction('order-1')).toEqual({ ok: true });

    expect(pickupEvents(BUYER.familyId)).toHaveLength(0);
    expect(otherEvents()).toEqual(['event-seller-swim', 'event-buyer-dentist']);
  });
});

describe('a pickup the seller confirmed', () => {
  beforeEach(async () => {
    proposedBy('buyer');
    as(SELLER);
    expect((await confirmHandoffAction('order-1')).ok).toBe(true);
    expect(pickupEvents(SELLER.familyId)).toHaveLength(1);
  });

  it('cancelled by the buyer: the seller\'s copy is not the buyer\'s to delete, and the miss is logged', async () => {
    as(BUYER);
    expect(await cancelHandoffAction('order-1')).toEqual({ ok: true });

    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'cancelled' });
    expect(pickupEvents(SELLER.familyId)).toHaveLength(1);
    expect(otherEvents()).toEqual(['event-seller-swim', 'event-buyer-dentist']);
    stayedOnCalendar();
  });

  it('with its order cancelled by the buyer: the same', async () => {
    as(BUYER);
    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: true });

    expect(pickupEvents(SELLER.familyId)).toHaveLength(1);
    expect(otherEvents()).toEqual(['event-seller-swim', 'event-buyer-dentist']);
    stayedOnCalendar();
  });

  it('with its order cancelled by the seller who confirmed it: their own copy comes off', async () => {
    as(SELLER);
    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: true });

    expect(pickupEvents(SELLER.familyId)).toHaveLength(0);
    expect(otherEvents()).toEqual(['event-seller-swim', 'event-buyer-dentist']);
  });
});
