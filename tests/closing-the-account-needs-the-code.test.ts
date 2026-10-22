// Closing the account needs the two-step code, like every other billing cancel.
//
// closeAccountAction sets every billable Stripe subscription to end at its
// period end and stamps families.closed_at; reopenAccountAction resumes it. The
// same Stripe cancel through /api/billing/cancel is refused for an `aal1`
// session (password only) of a parent who enrolled an authenticator
// (refuseWithoutBillingStepUp), the portal, checkout and change-plan routes
// likewise, and the seven money server actions go through moneyScope's
// aal2Verdict. These two actions had the role check alone. CloseAccountCard
// sits behind requireAal2 on /dashboard/billing, but the paywall gate renders
// for any locked family with no step-up at all, and a Next-Action POST needs no
// page — so someone holding a parent's password scheduled the cancellation and
// locked every member out.
//
// Pinned: with the code not yet entered nothing changes at Stripe or on the
// family row, and the answer says where the code goes; the three callers hand
// that answer to reportRefusal, so the family is taken to the code page and
// back rather than shown a dead-end toast; with the code entered, or for a
// family that never enrolled an authenticator, the same clicks work as before.
// The components below drive the REAL action through the harness.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const STEP_UP = '/auth/step-up?next=%2Fdashboard%2Fbilling';
// The real catalogue's sentence (lib/i18n/messages/en-US.json), not a key.
const NEEDS_CODE = "Enter your two-step code before changing the family's money.";

// The session's assurance level, as `readAssurance` sees it.
const NEVER_ENROLLED = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
const ENROLLED_NO_CODE_YET = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
const CODE_ENTERED = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const mocks = vi.hoisted(() => ({
  getAal: vi.fn(),
  update: vi.fn(),
  retrieve: vi.fn(),
  role: 'parent' as string,
  db: null as unknown,
  // The components call the actions through these, which the cases point at
  // the REAL actions below, so a click drives the whole path.
  closeAccountAction: vi.fn(),
  reopenAccountAction: vi.fn(),
  setActiveFamilyAction: vi.fn(),
  confirm: vi.fn(),
  assign: vi.fn(),
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/components/auth/sign-out-form', () => ({
  SignOutForm: ({ children }: { children: (s: { signingOut: boolean }) => unknown }) => children({ signingOut: false }),
}));
vi.mock('@/app/(app)/account/actions', () => ({
  closeAccountAction: () => mocks.closeAccountAction(),
  reopenAccountAction: () => mocks.reopenAccountAction(),
}));
vi.mock('@/app/(app)/actions', () => ({ setActiveFamilyAction: (id: string) => mocks.setActiveFamilyAction(id) }));

// The real action's dependencies.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-1', email: 'p@example.com' }, memberships: [], active: { familyId: 'family-1', role: mocks.role, member: { id: 'mem-1' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => mocks.db,
  createServer: async () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'synthetic-assurance-token' } }, error: null }), mfa: { getAuthenticatorAssuranceLevel: mocks.getAal } } }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { translate } = await import('@/lib/i18n/translate');
  const messages = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params) };
});
vi.mock('@/lib/stripe', () => ({ stripeFromKey: () => ({ subscriptions: { update: mocks.update, retrieve: mocks.retrieve } }) }));
vi.mock('@/lib/stripe/settings', () => ({ getStripeSettings: async () => null, effectiveSecretKey: () => 'sk_test_x' }));

const actions = await vi.importActual<typeof import('@/app/(app)/account/actions')>('@/app/(app)/account/actions');
const { CloseAccountCard } = await import('@/components/app/close-account-card');
const { TrialPaywallGate } = await import('@/components/app/trial-paywall-gate');
const { AccountClosedGate } = await import('@/components/app/account-closed-gate');

const FAMILY = 'family-1';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const family = () => db.table('families')[0];

beforeEach(() => {
  vi.clearAllMocks();
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.role = 'parent';
  mocks.update.mockResolvedValue({});
  mocks.confirm.mockReturnValue(true);
  mocks.closeAccountAction.mockImplementation(() => actions.closeAccountAction());
  mocks.reopenAccountAction.mockImplementation(() => actions.reopenAccountAction());
  db = createInMemorySupabase<SupabaseClient<Database>>();
  db.seed('families', [{ id: FAMILY, closed_at: null }]);
  db.seed('subscriptions', [{ id: 'sub-row-1', family_id: FAMILY, provider_ref: 'sub_123', status: 'active', cancel_at_period_end: false, plan: 'plus' }]);
  mocks.db = db;
  vi.stubGlobal('window', {
    confirm: mocks.confirm,
    location: { assign: mocks.assign, reload: vi.fn(), pathname: '/dashboard/billing', search: '' },
    addEventListener() {}, removeEventListener() {},
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('closing or reopening with the password alone, as a parent who enrolled an authenticator', () => {
  beforeEach(() => mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET));

  it('does not touch Stripe or the family row, and says where the code goes', async () => {
    expect(await actions.closeAccountAction()).toEqual({ ok: false, error: NEEDS_CODE, stepUp: STEP_UP });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(family().closed_at).toBeNull();
    expect(db.table('subscriptions')[0].cancel_at_period_end).toBe(false);
  });

  it('does not reopen a closed account or resume its billing either', async () => {
    family().closed_at = '2026-09-01T12:00:00.000Z';
    db.table('subscriptions')[0].cancel_at_period_end = true;
    expect(await actions.reopenAccountAction()).toEqual({ ok: false, error: NEEDS_CODE, stepUp: STEP_UP });
    expect(family().closed_at).toBe('2026-09-01T12:00:00.000Z');
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('the role is still decided first: a non-parent reads the role refusal, not a request for a code', async () => {
    mocks.role = 'adult';
    expect(await actions.closeAccountAction()).toEqual({ ok: false, error: 'Only a parent can close the account.' });
    expect(mocks.getAal).not.toHaveBeenCalled();
  });
});

describe('what the family SEES: each caller hands the refusal to reportRefusal', () => {
  beforeEach(() => mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET));

  it('the billing page\'s Close my account card', async () => {
    await (await import('./helpers/module-harness')).click(byName(render(h.hooks, createElement(CloseAccountCard)), 'Close my account'));
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(h.toasts.error).toEqual([NEEDS_CODE]);
    // Back to the page they were on once the code is entered.
    expect(mocks.assign).toHaveBeenCalledWith(STEP_UP);
    expect(family().closed_at).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('the paywall gate\'s Close account link — the path with no step-up anywhere above it', async () => {
    const { click, localeProviderModule } = await import('./helpers/module-harness');
    const t = localeProviderModule(h).useTranslations();
    await click(byName(render(h.hooks, createElement(TrialPaywallGate, { trialEndsAt: null })), t('trialPaywallGate.closeAccount')));
    expect(h.toasts.error).toEqual([NEEDS_CODE]);
    expect(mocks.assign).toHaveBeenCalledWith(STEP_UP);
    expect(family().closed_at).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('the closed-account gate\'s Reopen my account', async () => {
    family().closed_at = '2026-09-01T12:00:00.000Z';
    const { click, localeProviderModule } = await import('./helpers/module-harness');
    const t = localeProviderModule(h).useTranslations();
    await click(byName(render(h.hooks, createElement(AccountClosedGate)), t('accountClosedGate.reopenMyAccount')));
    expect(h.toasts.error).toEqual([NEEDS_CODE]);
    expect(mocks.assign).toHaveBeenCalledWith(STEP_UP);
    expect(family().closed_at).toBe('2026-09-01T12:00:00.000Z');
  });
});

describe('once the code is entered', () => {
  beforeEach(() => mocks.getAal.mockResolvedValue(CODE_ENTERED));

  it('the same close ends the billing and closes the account, as it always did', async () => {
    expect(await actions.closeAccountAction()).toEqual({ ok: true });
    expect(mocks.update).toHaveBeenCalledWith('sub_123', { cancel_at_period_end: true });
    expect(family().closed_at).toBeTruthy();
  });

  it('and the card\'s click closes it', async () => {
    await (await import('./helpers/module-harness')).click(byName(render(h.hooks, createElement(CloseAccountCard)), 'Close my account'));
    expect(h.toasts.error).toEqual([]);
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(family().closed_at).toBeTruthy();
  });
});

describe('a family that never set up an authenticator', () => {
  beforeEach(() => mocks.getAal.mockResolvedValue(NEVER_ENROLLED));

  it('is not asked for a code it does not have', async () => {
    expect(await actions.closeAccountAction()).toEqual({ ok: true });
    expect(family().closed_at).toBeTruthy();
  });
});
