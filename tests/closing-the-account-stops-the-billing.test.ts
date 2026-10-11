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
  retrieve: vi.fn(),
  secretKey: 'sk_test_x' as string | null,
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/stripe', () => ({ stripeFromKey: () => ({ subscriptions: { update: mocks.update, retrieve: mocks.retrieve } }) }));
vi.mock('@/lib/stripe/settings', () => ({
  getStripeSettings: async () => null,
  effectiveSecretKey: () => mocks.secretKey,
}));

import { closeAccountAction, reopenAccountAction } from '@/app/(app)/account/actions';

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

describe('a refused close whose rollback fails', () => {
  it('tells the family their subscription is still set to end, not only the log', async () => {
    db.seed('subscriptions', [
      { id: 'sub-row-2', family_id: FAMILY, provider_ref: 'sub_456', status: 'active', cancel_at_period_end: false, plan: 'plus' },
    ]);
    mocks.update
      .mockResolvedValueOnce({}) // sub_123 cancelled
      .mockRejectedValueOnce(new Error('stripe down')) // sub_456 refused: the close is refused
      .mockRejectedValueOnce(new Error('stripe still down')); // and sub_123 cannot be resumed
    const res = await closeAccountAction();
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('account.couldNotCloseTheAccount');
    expect(!res.ok && res.error).toContain('account.yourSubscriptionIsStillSetToEnd');
    expect(db.table('families')[0].closed_at).toBeNull();
  });

  it('says nothing more when the rollback lands', async () => {
    db.seed('subscriptions', [
      { id: 'sub-row-2', family_id: FAMILY, provider_ref: 'sub_456', status: 'active', cancel_at_period_end: false, plan: 'plus' },
    ]);
    mocks.update.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('stripe down'));
    const res = await closeAccountAction();
    expect(res).toEqual({ ok: false, error: 'account.couldNotCloseTheAccount' });
    expect(db.table('subscriptions').find((s) => s.id === 'sub-row-1')?.cancel_at_period_end).toBe(false);
  });
});

describe('reopening the account', () => {
  const CLOSED_AT = '2026-09-01T12:00:00.000Z';
  const seconds = (iso: string, deltaMs = 0) => Math.floor((Date.parse(iso) + deltaMs) / 1000);

  it('resumes the subscription the close set to end — a round trip through both actions', async () => {
    // A Stripe that remembers: cancelling stamps canceled_at, as Stripe does.
    const stripe = new Map<string, { cancel_at_period_end: boolean; canceled_at: number | null }>();
    mocks.update.mockImplementation(async (id: string, patch: { cancel_at_period_end: boolean }) => {
      stripe.set(id, { cancel_at_period_end: patch.cancel_at_period_end, canceled_at: patch.cancel_at_period_end ? Math.floor(Date.now() / 1000) : null });
      return {};
    });
    mocks.retrieve.mockImplementation(async (id: string) => stripe.get(id) ?? { cancel_at_period_end: false, canceled_at: null });

    expect(await closeAccountAction()).toEqual({ ok: true });
    expect(db.table('subscriptions').find((s) => s.id === 'sub-row-1')?.cancel_at_period_end).toBe(true);

    expect(await reopenAccountAction()).toEqual({ ok: true });
    expect(db.table('families')[0].closed_at).toBeNull();
    expect(mocks.update).toHaveBeenLastCalledWith('sub_123', { cancel_at_period_end: false });
    expect(db.table('subscriptions').find((s) => s.id === 'sub-row-1')?.cancel_at_period_end).toBe(false);
    // Another family's subscription is never looked at.
    expect(mocks.retrieve).not.toHaveBeenCalledWith('sub_999');
  });

  it('leaves a cancel the family made before closing, and tells them to resume it from billing', async () => {
    db.table('families')[0].closed_at = CLOSED_AT;
    db.table('subscriptions')[0].cancel_at_period_end = true;
    mocks.retrieve.mockResolvedValue({ cancel_at_period_end: true, canceled_at: seconds(CLOSED_AT, -3 * 86_400_000) });
    const res = await reopenAccountAction();
    expect(res).toEqual({ ok: true, notice: 'account.yourSubscriptionIsStillSetToEnd' });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(db.table('subscriptions')[0].cancel_at_period_end).toBe(true);
    expect(db.table('families')[0].closed_at).toBeNull();
  });

  it('resumes only the subscription cancelled within the close', async () => {
    db.table('families')[0].closed_at = CLOSED_AT;
    db.table('subscriptions')[0].cancel_at_period_end = true;
    db.seed('subscriptions', [
      { id: 'sub-row-2', family_id: FAMILY, provider_ref: 'sub_456', status: 'active', cancel_at_period_end: true, plan: 'plus' },
    ]);
    mocks.retrieve.mockImplementation(async (id: string) => ({
      cancel_at_period_end: true,
      canceled_at: id === 'sub_123' ? seconds(CLOSED_AT, -5_000) : seconds(CLOSED_AT, -86_400_000),
    }));
    const res = await reopenAccountAction();
    expect(res).toEqual({ ok: true, notice: 'account.yourSubscriptionIsStillSetToEnd' });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith('sub_123', { cancel_at_period_end: false });
    expect(db.table('subscriptions').find((s) => s.id === 'sub-row-2')?.cancel_at_period_end).toBe(true);
  });

  it('reopens even when billing cannot be reached, and says where to resume it', async () => {
    db.table('families')[0].closed_at = CLOSED_AT;
    db.table('subscriptions')[0].cancel_at_period_end = true;
    mocks.secretKey = null;
    const res = await reopenAccountAction();
    expect(res).toEqual({ ok: true, notice: 'account.yourSubscriptionIsStillSetToEnd' });
    expect(db.table('families')[0].closed_at).toBeNull();
  });

  it('reopens quietly when nothing was set to end', async () => {
    db.table('families')[0].closed_at = CLOSED_AT;
    expect(await reopenAccountAction()).toEqual({ ok: true });
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
});
