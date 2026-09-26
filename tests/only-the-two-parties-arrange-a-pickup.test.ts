import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A marketplace pickup is arranged by the two people in the exchange. The
 * hand-off actions used to treat anyone who was not the seller as the buyer,
 * so a sibling could propose, confirm (minting the hand-off code) or cancel
 * someone else's pickup. 0346 enforces the same in RLS.
 */
const harness = vi.hoisted(() => ({ db: null as unknown, memberId: 'member-x' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: 'family-1', role: 'teen', member: { id: harness.memberId, family_id: 'family-1' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const { proposeHandoffAction, confirmHandoffAction, cancelHandoffAction } = await import('@/app/(app)/marketplace/handoff/actions');

const FORBIDDEN = 'You are not part of this marketplace exchange.';

describe('arranging a marketplace pickup', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    db = createInMemorySupabase();
    harness.db = db;
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

  it('lets the buyer confirm the seller\'s proposal', async () => {
    harness.memberId = 'member-b';
    const res = await confirmHandoffAction('order-1');
    expect(res.ok).toBe(true);
    expect(db.table('marketplace_handoffs')[0]).toMatchObject({ status: 'confirmed' });
  });
});
