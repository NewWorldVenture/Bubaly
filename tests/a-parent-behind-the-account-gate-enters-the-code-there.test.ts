// A parent behind the closed-account gate or the paywall can enter the
// two-step code, and the click that asked for it then goes through.
//
// closeAccountAction and reopenAccountAction answer an `aal1` session of a
// parent who enrolled an authenticator with { ok: false, stepUp }, and the
// billing routes do the same (refuseWithoutBillingStepUp). The gates handed
// that to reportRefusal, which navigated to /auth/step-up?next=<here>. But the
// step-up page is an (app) route, and GatedShell (app/(app)/layout.tsx) returns
// <AccountClosedGate /> or <TrialPaywallGate /> IN PLACE of every (app) route's
// children: the step-up form never rendered, the parent landed on the gate
// again, clicked again, was refused again. A session reaches aal2 only through
// that form, so after a fresh password sign-in a closed account could never be
// reopened, and a locked family could neither close nor subscribe.
//
// The gates now ask for the code themselves, in place of their card, and retry
// the refused click once it is in. Driven here through the REAL layout against
// the in-memory database, the REAL gates and step-up form through the harness,
// and the REAL account actions and billing step-up check behind them. The
// browser's MFA client is the only thing modelled: it holds the session's
// assurance level, which entering the right code raises to aal2.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, change, click, has, nodes, render, settle, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const state = vi.hoisted(() => ({
  db: null as unknown,
  /** The signed-in session's assurance level: aal1 after the password, aal2 after the code. */
  level: 'aal1' as 'aal1' | 'aal2',
  assign: vi.fn(),
  reload: vi.fn(),
  confirm: vi.fn(),
  location: { href: '' },
  stripeUpdate: vi.fn(),
  stripeRetrieve: vi.fn(),
  verify: vi.fn(),
}));

const FAMILY = '00000000-0000-4000-8000-0000000fa111';
const PARENT = 'user-parent';
const FACTOR = { id: 'factor-totp', factor_type: 'totp', status: 'verified', created_at: '2026-01-01T00:00:00Z' };
const CODE = '246810';

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => ({ ...(await import('./helpers/module-harness')).toastModule(h), ToastProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/i18n/locale-provider', async () => ({
  ...(await import('./helpers/module-harness')).localeProviderModule(h),
  FamilyTimeZoneProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/auth/sign-out-form', () => ({
  SignOutForm: ({ children }: { children: (s: { signingOut: boolean }) => unknown }) => children({ signingOut: false }),
}));
// The six-box widget is not what this is about: one field with its name.
vi.mock('@/components/ui/otp-input', () => ({
  OtpInput: ({ value, onChange, ariaLabel, disabled }: { value: string; onChange: (v: string) => void; ariaLabel?: string; disabled?: boolean }) =>
    createElement('input', { 'aria-label': ariaLabel, value, disabled, onChange: (e: { target: { value: string } }) => onChange(e.target.value) }),
}));
// The browser half of MFA: the factor the parent enrolled, and the challenge
// that raises the session to aal2 for the right code.
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      mfa: {
        listFactors: async () => ({ data: { all: [FACTOR], totp: [FACTOR], phone: [] }, error: null }),
        challengeAndVerify: async (input: { factorId: string; code: string }) => {
          state.verify(input);
          if (input.factorId !== FACTOR.id || input.code !== CODE) {
            return { data: null, error: Object.assign(new Error('Invalid TOTP code entered'), { code: 'mfa_verification_failed', status: 422 }) };
          }
          state.level = 'aal2';
          return { data: { access_token: 'aal2-token' }, error: null };
        },
      },
    },
  }),
}));
vi.mock('@/app/(app)/actions', () => ({ setActiveFamilyAction: async () => ({ ok: true }) }));

// The server side: the layout's surroundings, and the actions' dependencies.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  isSuperAdmin: async () => false,
  requireUserContext: async () => ({
    user: { id: PARENT, email: 'parent@example.com' }, memberships: [],
    active: { familyId: FAMILY, role: 'parent', member: { id: 'm-parent', family_id: FAMILY } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/stripe', () => ({ stripeFromKey: () => ({ subscriptions: { update: state.stripeUpdate, retrieve: state.stripeRetrieve } }) }));
vi.mock('@/lib/stripe/settings', () => ({ getStripeSettings: async () => null, effectiveSecretKey: () => 'sk_test_x' }));
vi.mock('@/lib/server/family-time-zone', () => ({ activeFamilyTimeZone: async () => 'UTC' }));
vi.mock('@/components/i18n/scoped-locale-provider', () => ({ ScopedLocaleProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/ui/confirm', () => ({ ConfirmProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/auth/session-keeper', () => ({ SessionKeeper: () => null }));
vi.mock('@/components/app/app-lock-boundary', () => ({ AppLockBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/lib/security/app-lock-store', () => ({ readAppLockRecord: async () => ({ ok: true, record: null }) }));

const { default: AppGroupLayout } = await import('@/app/(app)/layout');
const { AccountClosedGate } = await import('@/components/app/account-closed-gate');
const { TrialPaywallGate } = await import('@/components/app/trial-paywall-gate');
const { refuseWithoutBillingStepUp } = await import('@/lib/billing/route-step-up');
const { requireUserContext } = await import('@/lib/supabase/auth');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

const NEEDS_CODE = t('actions.moneyNeedsYourCodeAgain');
const CLOSED_AT = '2026-09-01T12:00:00.000Z';
type Db = ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let db: Db;

/** One household with one parent, who enrolled an authenticator and signed in with the password alone. */
function household(family: Record<string, unknown>) {
  db = createInMemorySupabase<SupabaseClient<Database>>({ userId: PARENT });
  // The server session's assurance, as readAssurance reads it.
  Object.assign(db.auth, {
    getSession: async () => ({ data: { session: { access_token: `${state.level}-token` } }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.level, nextLevel: 'aal2' }, error: null }) },
  });
  db.seed('families', [{ id: FAMILY, name: 'The Parks', timezone: 'UTC', ...family }]);
  db.seed('family_members', [{ id: 'm-parent', family_id: FAMILY, user_id: PARENT, role: 'parent', is_active: true, created_at: '2026-01-01T00:00:00Z' }]);
  state.db = db;
}
const familyRow = () => db.table('families')[0];

/** Call the server components until the gate (a client component) is reached. */
async function resolveServer(node: ReactNode, clients: ReadonlySet<unknown>): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((child) => resolveServer(child, clients)));
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  const { type, props } = node as ReactElement<Record<string, unknown>>;
  if (clients.has(type)) return node;
  if (typeof type === 'function') return resolveServer(await (type as (p: unknown) => ReactNode | Promise<ReactNode>)(props), clients);
  const { children, ...rest } = props;
  if (children === undefined) return node;
  return createElement(type as string, rest, await resolveServer(children as ReactNode, clients));
}

/** What the layout draws over `child`: the gate element it chose, and whether the child is anywhere in it. */
async function layoutOver(child: string) {
  const gates = new Set<unknown>([AccountClosedGate, TrialPaywallGate]);
  const tree = await resolveServer(await AppGroupLayout({ children: child }), gates);
  const gate = nodes(tree).find((node) => gates.has(node.type)) as ReactElement | undefined;
  return { gate: gate ?? null, showsChild: has(tree, child) };
}

/** Render the gate, letting the step-up form's factor read land. */
async function screen(gate: ReactElement): Promise<ReturnType<typeof render>> {
  render(h.hooks, gate);
  await settle();
  return render(h.hooks, gate);
}

const codeField = (tree: ReturnType<typeof render>): Node => byName(tree, t('stepUp.codeLabel'), 'input');
const shownStepUp = (tree: ReturnType<typeof render>) => has(tree, t('stepUp.title')) && has(tree, t('stepUp.billingDescription'));

async function enterCode(gate: ReactElement, code: string) {
  change(codeField(await screen(gate)), code);
  await click(byName(await screen(gate), t('stepUp.continue')));
  // The retried action runs unawaited from the form's success handler.
  await settle();
  await settle();
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  state.level = 'aal1';
  state.location = { href: '' };
  state.assign.mockReset();
  state.reload.mockReset();
  state.verify.mockReset();
  state.confirm.mockReset().mockReturnValue(true);
  state.stripeUpdate.mockReset().mockResolvedValue({});
  state.stripeRetrieve.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('window', {
    confirm: state.confirm,
    location: Object.assign(state.location, { assign: state.assign, reload: state.reload, pathname: '/home', search: '' }),
    addEventListener() {}, removeEventListener() {},
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a closed family\'s parent, password only, with an authenticator enrolled', () => {
  beforeEach(() => {
    household({ trial_ends_at: null, closed_at: CLOSED_AT });
    // The close set the subscription to end; Stripe dates that cancel within the close.
    db.seed('subscriptions', [{ id: 'sub-row-1', family_id: FAMILY, provider_ref: 'sub_123', status: 'active', cancel_at_period_end: true, plan: 'plus' }]);
    state.stripeRetrieve.mockResolvedValue({ cancel_at_period_end: true, canceled_at: Date.parse(CLOSED_AT) / 1000 - 30 });
  });

  it('the layout draws the closed gate over every (app) route, the step-up page included — so the code is asked for in the gate', async () => {
    // The premise: navigating to /auth/step-up from here cannot help.
    const { gate, showsChild } = await layoutOver('STEP-UP-FORM');
    expect(gate?.type).toBe(AccountClosedGate);
    expect(showsChild).toBe(false);
  });

  it('reaches the code form from the gate, and once the code is in, the reopen goes through', async () => {
    const { gate } = await layoutOver('THE-APP');
    expect(gate!.props).toMatchObject({ canReopen: true });

    await click(byName(await screen(gate!), t('accountClosedGate.reopenMyAccount')));
    // Refused for the code, and nothing changed…
    expect(h.toasts.error).toEqual([NEEDS_CODE]);
    expect(familyRow().closed_at).toBe(CLOSED_AT);
    expect(state.stripeUpdate).not.toHaveBeenCalled();
    // …but the parent is NOT sent to a page this gate would cover: the form is here.
    expect(state.assign).not.toHaveBeenCalled();
    const asking = await screen(gate!);
    expect(shownStepUp(asking)).toBe(true);
    expect(allByName(asking, t('accountClosedGate.reopenMyAccount'))).toHaveLength(0);

    await enterCode(gate!, CODE);
    expect(state.verify).toHaveBeenCalledWith({ factorId: FACTOR.id, code: CODE });
    expect(state.level).toBe('aal2');
    // The same reopen, retried by the gate, now passes the action's own check.
    expect(familyRow().closed_at).toBeNull();
    expect(state.stripeUpdate).toHaveBeenCalledWith('sub_123', { cancel_at_period_end: false });
    expect(h.toasts.success).toEqual([t('accountClosedGate.welcomeBackYourAccountIs')]);
    expect(state.reload).toHaveBeenCalledTimes(1);
    expect(state.assign).not.toHaveBeenCalled();
  });

  it('a wrong code reopens nothing and leaves the form up to try again', async () => {
    const { gate } = await layoutOver('THE-APP');
    await click(byName(await screen(gate!), t('accountClosedGate.reopenMyAccount')));
    await enterCode(gate!, '000000');
    expect(state.level).toBe('aal1');
    expect(familyRow().closed_at).toBe(CLOSED_AT);
    expect(state.reload).not.toHaveBeenCalled();
    expect(shownStepUp(await screen(gate!))).toBe(true);
  });

  it('"Not now" puts the gate back without retrying', async () => {
    const { gate } = await layoutOver('THE-APP');
    await click(byName(await screen(gate!), t('accountClosedGate.reopenMyAccount')));
    await click(byName(await screen(gate!), t('stepUp.notNow')));
    const back = await screen(gate!);
    expect(shownStepUp(back)).toBe(false);
    expect(allByName(back, t('accountClosedGate.reopenMyAccount'))).toHaveLength(1);
    expect(familyRow().closed_at).toBe(CLOSED_AT);
    expect(h.toasts.error).toEqual([NEEDS_CODE]);
  });
});

describe('a trial-ended family\'s parent, password only, with an authenticator enrolled', () => {
  beforeEach(() => household({ trial_ends_at: '2026-09-01T00:00:00Z', closed_at: null }));

  it('the layout draws the paywall over every (app) route, the step-up page included', async () => {
    const { gate, showsChild } = await layoutOver('STEP-UP-FORM');
    expect(gate?.type).toBe(TrialPaywallGate);
    expect(showsChild).toBe(false);
  });

  it('reaches the code form from the paywall\'s Close account, and once the code is in, the close goes through', async () => {
    const { gate } = await layoutOver('THE-APP');
    await click(byName(await screen(gate!), t('trialPaywallGate.closeAccount')));
    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(h.toasts.error).toEqual([NEEDS_CODE]);
    expect(familyRow().closed_at).toBeNull();
    expect(state.assign).not.toHaveBeenCalled();
    expect(shownStepUp(await screen(gate!))).toBe(true);

    await enterCode(gate!, CODE);
    expect(state.level).toBe('aal2');
    expect(familyRow().closed_at).toBeTruthy();
    expect(h.toasts.success).toEqual([t('trialPaywallGate.yourAccountIsClosedYour')]);
    expect(state.reload).toHaveBeenCalledTimes(1);
    // The family confirmed once; the retry after the code does not ask again.
    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(state.assign).not.toHaveBeenCalled();
  });

  it('a plan\'s checkout, refused by the billing step-up check, is retried once the code is in', async () => {
    // The checkout route's own refusal (refuseWithoutBillingStepUp), reading
    // the same session: until the code, 403 with `stepUp`; after it, the URL.
    const checkoutUrl = 'https://checkout.stripe.test/session';
    const fetchMock = vi.fn(async () => {
      const refused = await refuseWithoutBillingStepUp(await requireUserContext(), t);
      const body = refused ? await refused.json() : { url: checkoutUrl };
      return { ok: !refused, status: refused ? refused.status : 200, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { gate } = await layoutOver('THE-APP');
    const choose = allByName(await screen(gate!), 'Choose');
    expect(choose.length).toBeGreaterThan(0);
    await click(choose[0]);
    expect(h.toasts.error).toEqual([NEEDS_CODE]);
    expect(state.location.href).toBe('');
    expect(state.assign).not.toHaveBeenCalled();
    expect(shownStepUp(await screen(gate!))).toBe(true);

    await enterCode(gate!, CODE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.location.href).toBe(checkoutUrl);
    expect(state.assign).not.toHaveBeenCalled();
  });
});
