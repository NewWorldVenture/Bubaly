import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A marketplace pickup is arranged by the two people in the exchange. The
 * hand-off actions used to treat anyone who was not the seller as the buyer,
 * so a sibling could propose, confirm (minting the hand-off code) or cancel
 * someone else's pickup. 0372 enforces the same in RLS.
 */
const harness = vi.hoisted(() => ({ db: null as unknown, memberId: 'member-x', role: 'teen' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: 'family-1', role: harness.role, member: { id: harness.memberId, family_id: 'family-1' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const { proposeHandoffAction, confirmHandoffAction, cancelHandoffAction, completeHandoffAction } = await import('@/app/(app)/marketplace/handoff/actions');

const FORBIDDEN = 'You are not part of this marketplace exchange.';
const ADULTS_ONLY = 'Only a parent/guardian can do this.';

/** What the RPC does once it is reached: it checks the family and the code, never the party (0199). */
function completeRpc(args: Record<string, unknown>, mem: InMemorySupabase) {
  const order = mem.table('marketplace_orders').find((o) => o.id === args.p_order_id);
  const handoff = mem.table('marketplace_handoffs').find((h) => h.order_id === args.p_order_id);
  if (!order || !handoff) return { ok: false, reason: 'order_not_found' };
  if (handoff.confirm_code !== args.p_code) return { ok: false, reason: 'code_mismatch' };
  handoff.status = 'completed';
  order.status = 'completed';
  return { ok: true };
}

describe('arranging a marketplace pickup', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    db = createInMemorySupabase({ rpc: { marketplace_complete_handoff: completeRpc } });
    harness.db = db;
    harness.role = 'teen';
    // Both parties are members of family-1: the in-family case.
    db.seed('family_members', [
      { id: 'member-b', family_id: 'family-1', role: 'teen', is_active: true },
      { id: 'member-s', family_id: 'family-1', role: 'parent', is_active: true },
      { id: 'member-x', family_id: 'family-1', role: 'child', is_active: true },
    ]);
    db.seed('marketplace_orders', [{
      id: 'order-1', family_id: 'family-1', listing_id: 'listing-1',
      buyer_member: 'member-b', seller_member: 'member-s', status: 'confirmed',
    }]);
    db.seed('marketplace_handoffs', [{
      id: 'handoff-1', order_id: 'order-1', family_id: 'family-1', listing_id: 'listing-1',
      proposed_by: 'member-s', proposer_role: 'seller', status: 'proposed', location_label: 'Library',
      meet_at: null, confirm_code: null,
    }]);
  });

  it('refuses a family member who is not in the exchange', async () => {
    harness.memberId = 'member-x';
    expect(await proposeHandoffAction({ orderId: 'order-1', locationLabel: 'Park' })).toEqual({ ok: false, error: FORBIDDEN });
    expect(await confirmHandoffAction('order-1')).toEqual({ ok: false, error: FORBIDDEN });
    expect(await cancelHandoffAction('order-1')).toEqual({ ok: false, error: FORBIDDEN });
    const [handoff] = db.table('marketplace_handoffs');
    expect(handoff).toMatchObject({ status: 'proposed', confirm_code: null, location_label: 'Library' });
  });

  it('refuses a sibling who is not a party completing the pickup with the family-readable code', async () => {
    // The hand-off code is readable by the whole family (the handoffs SELECT
    // policy), and the RPC checks only family membership, so the action is
    // the party check.
    const [handoff] = db.table('marketplace_handoffs');
    Object.assign(handoff, { status: 'confirmed', confirm_code: 'ABC123' });
    harness.memberId = 'member-x';
    expect(await completeHandoffAction({ orderId: 'order-1', code: 'ABC123' })).toEqual({ ok: false, error: FORBIDDEN });
    expect(db.table('marketplace_orders')[0]).toMatchObject({ status: 'confirmed' });
    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'confirmed' });
  });

  it('lets a party complete the pickup with the code', async () => {
    Object.assign(db.table('marketplace_handoffs')[0], { status: 'confirmed', confirm_code: 'ABC123' });
    harness.memberId = 'member-b';
    expect(await completeHandoffAction({ orderId: 'order-1', code: 'ABC123' })).toEqual({ ok: true });
    expect(db.table('marketplace_orders')[0]).toMatchObject({ status: 'completed' });
  });

  it('refuses a teen arranging to meet another household\'s adult, and lets a parent', async () => {
    // The seller is from another family (an auction or circle purchase).
    db.replace('family_members', db.table('family_members').filter((m) => m.id !== 'member-s'));
    harness.memberId = 'member-b';
    expect(await confirmHandoffAction('order-1')).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(await proposeHandoffAction({ orderId: 'order-1', locationLabel: 'Park' })).toEqual({ ok: false, error: ADULTS_ONLY });
    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'proposed', confirm_code: null, location_label: 'Library' });

    harness.role = 'parent';
    expect((await confirmHandoffAction('order-1')).ok).toBe(true);
  });

  it('lets the buyer confirm the seller\'s proposal', async () => {
    harness.memberId = 'member-b';
    const res = await confirmHandoffAction('order-1');
    expect(res.ok).toBe(true);
    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'confirmed' });
  });
});
