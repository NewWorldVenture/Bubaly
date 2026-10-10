// Closing the account stops the billing. closeAccountAction used to set
// families.closed_at and nothing else, so the closed family's Stripe
// subscription kept renewing. It now asks Stripe to end every billable
// subscription at its period end FIRST, and refuses the close when it cannot.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServiceClient: vi.fn(),
  update: vi.fn(),
  secretKey: 'sk_test_x' as string | null,
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/stripe', () => ({ stripeFromKey: () => ({ subscriptions: { update: mocks.update } }) }));
vi.mock('@/lib/stripe/settings', () => ({
  getStripeSettings: async () => null,
  effectiveSecretKey: () => mocks.secretKey,
}));

import { closeAccountAction } from '@/app/(app)/account/actions';

const FAMILY = 'family-1';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.secretKey = 'sk_test_x';
  mocks.update.mockResolvedValue({});
  db = createInMemorySupabase<SupabaseClient<Database>>();
  db.seed('families', [{ id: FAMILY, closed_at: null }]);
  db.seed('subscriptions', [
    { id: 'sub-row-1', family_id: FAMILY, provider_ref: 'sub_123', status: 'active', cancel_at_period_end: false, plan: 'plus' },
    { id: 'sub-row-other', family_id: 'family-2', provider_ref: 'sub_999', status: 'active', cancel_at_period_end: false, plan: 'plus' },
  ]);
  mocks.createServiceClient.mockReturnValue(db);
  mocks.requireUserContext.mockResolvedValue({ user: { id: 'user-1' }, active: { familyId: FAMILY, role: 'parent' } });
});

describe('closing the account', () => {
  it('ends the family\'s Stripe subscription at period end and records it', async () => {
    const res = await closeAccountAction();
    expect(res).toEqual({ ok: true });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith('sub_123', { cancel_at_period_end: true });
    expect(db.table('subscriptions').find((s) => s.id === 'sub-row-1')?.cancel_at_period_end).toBe(true);
    // Another family's subscription is untouched.
    expect(db.table('subscriptions').find((s) => s.id === 'sub-row-other')?.cancel_at_period_end).toBe(false);
    expect(db.table('families')[0].closed_at).toBeTruthy();
  });

  it('does not close the account when Stripe refuses the cancel', async () => {
    mocks.update.mockRejectedValueOnce(new Error('stripe down'));
    const res = await closeAccountAction();
    expect(res).toMatchObject({ ok: false, error: 'account.couldNotCloseTheAccount' });
    expect(db.table('families')[0].closed_at).toBeNull();
  });

  it('does not close a billed account when billing is not configured', async () => {
    mocks.secretKey = null;
    const res = await closeAccountAction();
    expect(res.ok).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(db.table('families')[0].closed_at).toBeNull();
  });

  it('resumes the subscription when the close itself does not land', async () => {
    db.table('families').length = 0; // the close matches no row
    const res = await closeAccountAction();
    expect(res.ok).toBe(false);
    expect(mocks.update).toHaveBeenNthCalledWith(1, 'sub_123', { cancel_at_period_end: true });
    expect(mocks.update).toHaveBeenNthCalledWith(2, 'sub_123', { cancel_at_period_end: false });
    expect(db.table('subscriptions').find((s) => s.id === 'sub-row-1')?.cancel_at_period_end).toBe(false);
  });

  it('closes a family with nothing left to bill without calling Stripe', async () => {
    db.table('subscriptions')[0].status = 'canceled';
    mocks.secretKey = null;
    const res = await closeAccountAction();
    expect(res).toEqual({ ok: true });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(db.table('families')[0].closed_at).toBeTruthy();
  });
});
