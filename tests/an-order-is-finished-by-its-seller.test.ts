import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A marketplace order is marked returned or complete by its seller — on a rent
 * or a borrow, the lender.
 *
 * `setOrderStatusAction` let either party take any legal step, and the Orders
 * page offered both of them every button. So the borrower could press "Mark
 * returned" or "Complete" on an item still in their hands: that ends the overdue
 * reminders (the return-reminders cron reads only `confirmed` and `active`
 * orders) and opens reviews. A buyer could complete a sale the seller never
 * handed over the same way. Starting and cancelling stay with either party, and
 * completing in person with the hand-off code is a separate path.
 */
const harness = vi.hoisted(() => ({ db: null as unknown, memberId: 'member-b' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.memberId}` },
    memberships: [],
    active: { familyId: 'family-1', role: 'parent', member: { id: harness.memberId, family_id: 'family-1' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const { setOrderStatusAction } = await import('@/app/(app)/marketplace/actions');
const { mayTakeOrderStep } = await import('@/lib/marketplace/order-lifecycle');

const SELLERS_STEP = 'Only the person who sold or lent this can mark it returned or complete.';

describe('finishing a marketplace order', () => {
  let db: InMemorySupabase;
  beforeEach(() => {
    db = createInMemorySupabase();
    harness.db = db;
    db.seed('marketplace_orders', [{
      id: 'order-1', family_id: 'family-1', listing_id: 'listing-1',
      buyer_member: 'member-b', seller_member: 'member-s', kind: 'borrow', status: 'active',
    }]);
  });
  const order = () => db.table('marketplace_orders')[0];

  it('does not let the borrower mark the item returned', async () => {
    harness.memberId = 'member-b';
    expect(await setOrderStatusAction('order-1', 'returned')).toEqual({ ok: false, error: SELLERS_STEP });
    expect(order().status).toBe('active');
  });

  it('does not let the borrower or buyer complete it', async () => {
    harness.memberId = 'member-b';
    expect(await setOrderStatusAction('order-1', 'completed')).toEqual({ ok: false, error: SELLERS_STEP });
    order().status = 'returned';
    expect(await setOrderStatusAction('order-1', 'completed')).toEqual({ ok: false, error: SELLERS_STEP });
    expect(order().status).toBe('returned');
  });

  it('does not let someone outside the exchange finish it', async () => {
    harness.memberId = 'member-x';
    expect(await setOrderStatusAction('order-1', 'completed')).toEqual({ ok: false, error: SELLERS_STEP });
    expect(order().status).toBe('active');
  });

  it('lets the lender mark it returned, then complete', async () => {
    harness.memberId = 'member-s';
    expect(await setOrderStatusAction('order-1', 'returned')).toEqual({ ok: true });
    expect(await setOrderStatusAction('order-1', 'completed')).toEqual({ ok: true });
    expect(order().status).toBe('completed');
  });

  it('still lets the buyer start or cancel an exchange', async () => {
    harness.memberId = 'member-b';
    order().status = 'confirmed';
    expect(await setOrderStatusAction('order-1', 'active')).toEqual({ ok: true });
    order().status = 'confirmed';
    expect(await setOrderStatusAction('order-1', 'cancelled')).toEqual({ ok: true });
    expect(order().status).toBe('cancelled');
  });

  it('answers a step that is no longer offered as stale, whoever asks', async () => {
    harness.memberId = 'member-b';
    order().status = 'confirmed';
    expect(await setOrderStatusAction('order-1', 'completed')).toEqual({
      ok: false, error: 'This order has moved on since you opened it. Refresh to see its current step.',
    });
  });
});

describe('the Orders page offers each side its own steps', () => {
  it('keeps returned and complete for the seller', () => {
    expect(mayTakeOrderStep('seller', 'returned')).toBe(true);
    expect(mayTakeOrderStep('seller', 'completed')).toBe(true);
    expect(mayTakeOrderStep('buyer', 'returned')).toBe(false);
    expect(mayTakeOrderStep('buyer', 'completed')).toBe(false);
    for (const step of ['confirmed', 'active', 'cancelled']) {
      expect(mayTakeOrderStep('buyer', step), step).toBe(true);
      expect(mayTakeOrderStep('seller', step), step).toBe(true);
    }
  });

  it('filters the buttons by the viewer\'s side, which the page passes in', () => {
    const controls = readFileSync('components/marketplace/order-controls.tsx', 'utf8');
    expect(controls).toMatch(/\.filter\(\(s\) => mayTakeOrderStep\(viewerRole, s\.status\)\)/);
    const page = readFileSync('app/(app)/marketplace/orders/page.tsx', 'utf8');
    expect(page).toContain('<OrderControls orderId={o.id} status={o.status} viewerRole={role} />');
  });
});
