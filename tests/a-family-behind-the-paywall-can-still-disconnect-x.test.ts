// household-roles N2-R1, round 2 — a family behind the (app) shell's paywall
// or closed-account gate can still disconnect X, and Bubaly then holds none of
// its tokens.
//
// The first fix let a family without Social disconnect its accounts from the
// social layout, which shows them in place of the console. That reached a
// grandfathered Free family (trial_ends_at NULL) and any family with Social
// switched off. But every family created since migration 0164 carries a
// trial_ends_at, and once its trial has passed with no paid subscription (a
// lapsed trial, or Basic paid for and then cancelled: "connects X on Basic,
// then downgrades") it is LOCKED. GatedShell (app/(app)/layout.tsx) then
// returns <TrialPaywallGate /> in place of every (app) route, the social layout
// and its list included, and the paywall offers plans, pricing, log out and
// closing the account. Closing deletes nothing, X's tokens included, and
// <AccountClosedGate /> replaced every route the same way. Nothing left in
// Bubaly could clear them.
//
// The layout now hands either gate the accounts the member may still
// disconnect. Driven here: the REAL layout against an in-memory database (a
// post-0164 family whose trial ended on 1 September and whose Basic
// subscription was cancelled), the REAL gates and AccountRow through the
// harness, and the REAL disconnect action, social-role resolver and token
// clear behind the button.
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, click, has, nodes, render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import { buildAppLockConfig } from '@/lib/security/app-lock';
import { APP_UNLOCK_COOKIE } from '@/lib/security/app-lock-server';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const server = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as unknown as { user: { id: string; email: string | null }; memberships: unknown[]; active: Record<string, unknown> & { familyId: string } },
  /** This browser's cookies, where the server sets an App Lock unlock. */
  jar: new Map<string, string>(),
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => ({ ...(await import('./helpers/module-harness')).toastModule(h), ToastProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/i18n/locale-provider', async () => ({
  ...(await import('./helpers/module-harness')).localeProviderModule(h),
  FamilyTimeZoneProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT ${url}`); },
  notFound: () => { throw new Error('NOT_FOUND'); },
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
}));
vi.mock('@/components/auth/sign-out-form', () => ({
  SignOutForm: ({ children }: { children: ReactNode | ((s: { signingOut: boolean }) => ReactNode) }) =>
    typeof children === 'function' ? children({ signingOut: false }) : children,
}));
// The gates' own actions are not what this is about.
vi.mock('@/app/(app)/account/actions', () => ({
  closeAccountAction: async () => { throw new Error('not under test'); },
  reopenAccountAction: async () => { throw new Error('not under test'); },
}));
vi.mock('@/app/(app)/actions', () => ({ setActiveFamilyAction: async () => ({ ok: true }) }));

// The server side: the layout's surroundings, and what the disconnect action needs.
vi.mock('next/cache', () => ({ revalidatePath() {} }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (server.jar.has(name) ? { name, value: server.jar.get(name)! } : undefined),
    set: (name: string, value: string) => { server.jar.set(name, value); },
    delete: (arg: string | { name: string }) => { server.jar.delete(typeof arg === 'string' ? arg : arg.name); },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => server.db, createServiceClient: () => server.db }));
vi.mock('@/lib/supabase/auth', () => ({
  isSuperAdmin: async () => false,
  requireUserContext: async () => server.ctx,
  requireFeature: async () => { throw new Error('not under test'); },
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/server/family-time-zone', () => ({ activeFamilyTimeZone: async () => 'UTC' }));
vi.mock('@/components/i18n/scoped-locale-provider', () => ({ ScopedLocaleProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/ui/confirm', () => ({ ConfirmProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/auth/session-keeper', () => ({ SessionKeeper: () => null }));
// App Lock is decided on the server (the layout, against the REAL private
// store, lib/security/app-lock-store.ts, over the in-memory database), and
// AppLockGate is the REAL lock screen, posting the PIN to the REAL
// unlockAppAction: the card inside the gate waits for the PIN
// (N2-R1-APPLOCK, below). AppLockBoundary's own lifecycle (retiring a page
// already delivered, cross-tab locks) has its browser suite
// (tests/e2e/app-lock-browser-boundary.spec.ts); here it is what it draws on
// the server's word: the lock screen while locked, the children otherwise.
vi.mock('@/components/app/app-lock-boundary', async () => {
  const { createElement } = await import('react');
  const { AppLockGate } = await import('@/components/app/app-lock-gate');
  return { AppLockBoundary: ({ locked, children }: { locked: boolean; children?: ReactNode }) => (locked ? createElement(AppLockGate) : children) };
});

const { default: AppGroupLayout } = await import('@/app/(app)/layout');

const FAMILY = 'f0000000-0000-4000-8000-000000000001';
const USERS = { parent: 'a0000000-0000-4000-8000-000000000001', child: 'a0000000-0000-4000-8000-000000000003' } as const;
type Who = keyof typeof USERS;
const X_ACCOUNT = 'e0000000-0000-4000-8000-000000000001';
const THE_APP = 'THE-APP';
const LEFT_CONNECTED = "Social media tools aren't available to your family right now";
const stamps = { created_at: '2026-06-01T00:00:00.000Z', updated_at: '2026-06-01T00:00:00.000Z' };

/**
 * A family created after 0164, signed in as `who`: its five-day trial ended on
 * 1 September, and the Basic plan it bought was cancelled, so it is locked.
 */
function household(who: Who, family: Record<string, unknown> = {}): InMemorySupabase {
  const db = createInMemorySupabase({ userId: USERS[who], maxRows: 1000, rpc: { rate_limit_hit: rateLimitHit } });
  // The browser's auth session, whose id an App Lock unlock is bound to.
  const token = `header.${Buffer.from(JSON.stringify({ sub: USERS[who], session_id: crypto.randomUUID() })).toString('base64url')}.signature`;
  Object.assign(db.auth, { getSession: async () => ({ data: { session: { access_token: token } }, error: null }) });
  db.seed('families', [{ id: FAMILY, name: 'Rivera household', timezone: 'UTC', trial_ends_at: '2026-09-01T00:00:00.000Z', closed_at: null, ...family }]);
  db.seed('subscriptions', [{ id: 's-1', family_id: FAMILY, plan: 'basic', status: 'canceled', current_period_end: '2026-10-01T00:00:00.000Z' }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: FAMILY, user_id: USERS.parent, role: 'parent', is_active: true, display_name: 'Ana', created_at: '2026-06-01T00:00:00.000Z' },
    { id: 'm-child', family_id: FAMILY, user_id: USERS.child, role: 'child', is_active: true, display_name: 'Leo', created_at: '2026-06-01T00:00:00.000Z' },
  ]);
  server.db = db;
  server.ctx = {
    user: { id: USERS[who], email: null }, memberships: [],
    active: { familyId: FAMILY, role: who, member: { id: `m-${who}` }, family: { id: FAMILY, timezone: 'UTC' } },
  };
  return db;
}

/** The X account the family connected on Basic, and the tokens Bubaly keeps for it. */
function withConnectedX(db: InMemorySupabase): InMemorySupabase {
  db.seed('social_accounts', [{
    id: X_ACCOUNT, family_id: FAMILY, user_id: USERS.parent, platform: 'x', status: 'connected', display_name: 'Rivera fair on X',
    handle: 'riverafair', provider_account_id: '123456789', scopes: [], last_error: null, last_synced_at: null, deleted_at: null,
    created_by: USERS.parent, updated_by: null, metadata: {}, ...stamps,
  }]);
  db.seed('social_account_tokens', [{
    id: X_ACCOUNT, account_id: X_ACCOUNT, family_id: FAMILY, platform: 'x', provider_account_id: '123456789',
    access_token_enc: 'sealed-access-token', refresh_token_enc: 'sealed-refresh-token', expires_at: null,
    created_by: USERS.parent, updated_by: null, metadata: { x_state: 'connected' }, ...stamps,
  }]);
  return db;
}
const PIN = '4821';
/** The parent set an App Lock PIN (Settings, Security), kept in the server's private store. */
async function withAppLock(db: InMemorySupabase, enabled = true): Promise<InMemorySupabase> {
  const { salt, hash } = await buildAppLockConfig(PIN);
  db.seed('app_lock_credentials', [{ user_id: USERS.parent, enabled, salt, hash, revision: crypto.randomUUID() }]);
  return db;
}
const LOCK_SCREEN = 'Enter your PIN';
const reload = vi.fn();
/**
 * Type the PIN on the real lock screen's keypad, wait for the server to check
 * it, and open the fresh document a right PIN opens: the server renders the
 * layout again, now with this browser's unlock.
 */
async function enterPin(element: ReactElement, pin: string): Promise<ReactNode> {
  let tree = render(h.hooks, element);
  for (const digit of pin) {
    await click(byName(tree, digit, 'button'));
    tree = render(h.hooks, element);
  }
  for (let tick = 0; tick < 50 && reload.mock.calls.length === 0; tick++) await settle();
  expect(reload, 'a right PIN opens a fresh document').toHaveBeenCalledTimes(1);
  resetHookSlots(h.hooks);
  return (await screen()).tree;
}
const token = (db: InMemorySupabase) => db.table('social_account_tokens').find((row) => row.id === X_ACCOUNT)!;
const account = (db: InMemorySupabase) => db.table('social_accounts').find((row) => row.id === X_ACCOUNT)!;

/**
 * Await every async (server) component, depth first, and leave the rest to the
 * harness: the gates and AccountRow are client components with hooks.
 */
async function resolveServer(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServer));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') {
    return resolveServer(await (node.type as (props: unknown) => Promise<ReactNode>)(node.props));
  }
  if (!Object.prototype.hasOwnProperty.call(node.props, 'children')) return node;
  return cloneElement(node, {}, await resolveServer(node.props.children));
}

/** The (app) layout over every route, as the signed-in member sees it. */
async function screen() {
  const element = (await resolveServer(await AppGroupLayout({ children: THE_APP }))) as ReactElement;
  // What the server hands the browser: every prop of every client component
  // is serialised into the payload, drawn or not.
  const payload = JSON.stringify(element);
  const tree = render(h.hooks, element);
  const gates = nodes(tree).filter((node) => node.props.role === 'dialog');
  return { tree, element, gated: gates.length > 0, showsApp: has(tree, THE_APP), sent: (value: string) => payload.includes(value) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  reload.mockReset();
  vi.stubGlobal('window', { confirm: () => true, location: { assign() {}, reload, replace() {}, pathname: '/home', search: '' }, addEventListener() {}, removeEventListener() {} });
  server.jar.clear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a locked family (trial over, Basic cancelled) with X still connected', () => {
  it('shows the parent, behind the paywall, the account and its Disconnect, and nothing of the app', async () => {
    withConnectedX(household('parent'));
    const { tree, gated, showsApp } = await screen();
    expect(gated, 'the paywall is still what the family meets').toBe(true);
    expect(showsApp).toBe(false);
    expect(has(tree, 'Your free trial has ended')).toBe(true);
    expect(has(tree, LEFT_CONNECTED)).toBe(true);
    expect(has(tree, 'Rivera fair on X')).toBe(true);
    expect(allByName(tree, 'Disconnect', 'button')).toHaveLength(1);
    // The billing page is behind this same paywall; the plans are the paywall's own.
    expect(nodes(tree).filter((node) => typeof node.props.href === 'string' && node.props.href.startsWith('/dashboard/billing'))).toEqual([]);
  });

  it('pressing Disconnect there, through the real action, deletes the tokens Bubaly kept and takes the account off the paywall', async () => {
    const db = withConnectedX(household('parent'));
    await click(byName((await screen()).tree, 'Disconnect', 'button'));
    expect(h.toasts.error).toEqual([]);
    expect(token(db)).toMatchObject({ access_token_enc: null, refresh_token_enc: null, metadata: expect.objectContaining({ x_state: 'blocked' }) });
    expect(account(db)).toMatchObject({ status: 'disconnected', deleted_at: expect.any(String) });
    resetHookSlots(h.hooks);
    const after = await screen();
    expect(after.gated).toBe(true);
    expect(has(after.tree, 'Rivera fair on X')).toBe(false);
    expect(has(after.tree, LEFT_CONNECTED), 'nothing is left to disconnect').toBe(false);
  });

  it('shows a child, who may not disconnect, the paywall alone (control)', async () => {
    const db = withConnectedX(household('child'));
    const { tree, gated } = await screen();
    expect(gated).toBe(true);
    expect(has(tree, 'Rivera fair on X')).toBe(false);
    expect(has(tree, LEFT_CONNECTED)).toBe(false);
    expect(allByName(tree, 'Disconnect', 'button')).toHaveLength(0);
    expect(token(db).access_token_enc).toBe('sealed-access-token');
  });

  it('a locked family with nothing connected meets the paywall as before (control)', async () => {
    household('parent');
    const { tree, gated } = await screen();
    expect(gated).toBe(true);
    expect(has(tree, LEFT_CONNECTED)).toBe(false);
  });

  it('a family whose Basic plan is active gets the app, and no gate (control)', async () => {
    const db = withConnectedX(household('parent'));
    db.table('subscriptions')[0].status = 'active';
    const { gated, showsApp } = await screen();
    expect(gated).toBe(false);
    expect(showsApp).toBe(true);
  });
});

describe('a closed family with X still connected', () => {
  it('shows the parent, behind the closed-account gate, the account and its Disconnect, which clears the tokens', async () => {
    const db = withConnectedX(household('parent', { closed_at: '2026-10-01T09:00:00.000Z' }));
    const { tree, gated, showsApp } = await screen();
    expect(gated).toBe(true);
    expect(showsApp).toBe(false);
    expect(has(tree, 'Your account is closed')).toBe(true);
    expect(has(tree, 'Rivera fair on X')).toBe(true);
    await click(byName(tree, 'Disconnect', 'button'));
    expect(token(db)).toMatchObject({ access_token_enc: null, refresh_token_enc: null });
  });

  it('shows a child the closed-account gate alone (control)', async () => {
    withConnectedX(household('child', { closed_at: '2026-10-01T09:00:00.000Z' }));
    const { tree, gated } = await screen();
    expect(gated).toBe(true);
    expect(has(tree, 'Rivera fair on X')).toBe(false);
  });

  it('a social read that fails still shows the gate, without the accounts', async () => {
    const db = withConnectedX(household('parent', { closed_at: '2026-10-01T09:00:00.000Z' }));
    const from = db.from.bind(db);
    db.from = ((table: string) => {
      if (table === 'social_accounts') throw new Error('storage unavailable');
      return from(table);
    }) as typeof db.from;
    const { tree, gated } = await screen();
    expect(gated).toBe(true);
    expect(has(tree, 'Your account is closed')).toBe(true);
    expect(has(tree, LEFT_CONNECTED)).toBe(false);
  });
});

// household-roles N2-R1-APPLOCK, round 3. The card is drawn inside either gate,
// and either gate returned before the read that decided App Lock, so a parent
// who set a PIN had the accounts' names, statuses and last errors, and a
// working Disconnect that deletes the family's X tokens, shown to anyone
// holding the signed-in device. The card waits behind the PIN like the rest of
// the app.
//
// N3-R1-APPLOCK-FOCUS, round 4: round 3 drew the lock INSIDE the gate, a modal
// dialog in a modal dialog, and the gate's focus trap won: focus began on
// "Choose" or "Reopen my account" behind "Enter your PIN"
// (tests/e2e/the-lock-screen-is-the-one-dialog-over-the-gate.spec.ts drives it
// in Chromium). One dialog at a time: while locked, the lock is drawn in place
// of the gate, and the gate, with the accounts, once the PIN is in.
//
// Both now hold through main's server-side App Lock (4569189e0, 81ca007b4):
// the layout reads the private lock record before billing, and a locked
// browser is sent the lock screen alone, the gate and its card included; the
// PIN is checked by unlockAppAction, which sets this browser's unlock cookie,
// and the fresh document after it is the gate with its accounts. A lock record
// that cannot be read withholds the whole app, the gate and its card with it.
const dialogs = (tree: ReactNode) => nodes(tree).filter((node) => node.props.role === 'dialog').map((node) => node.props['aria-labelledby']);
const LOCK_UNAVAILABLE = 'We could not confirm your lock settings';
/** The paywall's trialEndsAt prop: on the payload whenever the paywall is. */
const TRIAL_ENDED = '2026-09-01T00:00:00.000Z';
describe('a parent who set an App Lock PIN, behind the gate, with X still connected', () => {
  it('meets the lock in place of the paywall: no plan, no account and no Disconnect until the PIN is entered', async () => {
    const db = await withAppLock(withConnectedX(household('parent')));
    const { tree, element, sent } = await screen();
    expect(sent('Rivera fair on X'), 'nothing of the card is sent to a locked browser').toBe(false);
    expect(sent(TRIAL_ENDED), 'nor of the paywall').toBe(false);
    expect(dialogs(tree), 'one dialog: the lock').toEqual(['app-lock-title']);
    expect(has(tree, LOCK_SCREEN)).toBe(true);
    expect(has(tree, 'Your free trial has ended'), 'nothing of the paywall is behind the lock').toBe(false);
    expect(allByName(tree, 'Choose', 'button')).toHaveLength(0);
    expect(has(tree, 'Rivera fair on X')).toBe(false);
    expect(has(tree, LEFT_CONNECTED)).toBe(false);
    expect(allByName(tree, 'Disconnect', 'button')).toHaveLength(0);

    const unlocked = await enterPin(element, PIN);
    expect(server.jar.get(APP_UNLOCK_COOKIE), 'the server set this browser an unlock for this member').toMatch(new RegExp(`^v2\\.${USERS.parent}\\.`));
    expect(has(unlocked, LOCK_SCREEN)).toBe(false);
    expect(dialogs(unlocked)).toEqual(['paywall-title']);
    expect(has(unlocked, 'Your free trial has ended')).toBe(true);
    expect(allByName(unlocked, 'Choose', 'button')).toHaveLength(2);
    expect(has(unlocked, 'Rivera fair on X')).toBe(true);
    await click(byName(unlocked, 'Disconnect', 'button'));
    expect(token(db)).toMatchObject({ access_token_enc: null, refresh_token_enc: null });
  });

  it('meets the lock in place of the closed-account gate the same way, and the gate with its accounts after the PIN', async () => {
    const db = await withAppLock(withConnectedX(household('parent', { closed_at: '2026-10-01T09:00:00.000Z' })));
    const { tree, element, sent } = await screen();
    expect(sent('Rivera fair on X'), 'nothing of the card is sent to a locked browser').toBe(false);
    expect(sent('canReopen'), 'nor of the closed-account gate').toBe(false);
    expect(dialogs(tree), 'one dialog: the lock').toEqual(['app-lock-title']);
    expect(has(tree, LOCK_SCREEN)).toBe(true);
    expect(has(tree, 'Your account is closed'), 'nothing of the gate is behind the lock').toBe(false);
    expect(allByName(tree, 'Reopen my account', 'button')).toHaveLength(0);
    expect(has(tree, 'Rivera fair on X')).toBe(false);
    expect(allByName(tree, 'Disconnect', 'button')).toHaveLength(0);
    expect(token(db).access_token_enc).toBe('sealed-access-token');

    const unlocked = await enterPin(element, PIN);
    expect(dialogs(unlocked)).toEqual(['closed-title']);
    expect(has(unlocked, 'Your account is closed')).toBe(true);
    expect(allByName(unlocked, 'Reopen my account', 'button')).toHaveLength(1);
    await click(byName(unlocked, 'Disconnect', 'button'));
    expect(token(db)).toMatchObject({ access_token_enc: null, refresh_token_enc: null });
  });

  it('a wrong PIN leaves the lock alone on the page, and nothing of the gate (control)', async () => {
    await withAppLock(withConnectedX(household('parent')));
    const { element } = await screen();
    let tree = render(h.hooks, element);
    for (const digit of '0000') {
      await click(byName(tree, digit, 'button'));
      tree = render(h.hooks, element);
    }
    for (let tick = 0; tick < 5; tick++) await settle();
    tree = render(h.hooks, element);
    expect(reload).not.toHaveBeenCalled();
    expect(server.jar.has(APP_UNLOCK_COOKIE)).toBe(false);
    expect(dialogs(tree)).toEqual(['app-lock-title']);
    expect(has(tree, 'Rivera fair on X')).toBe(false);
  });

  it('is shown the accounts at once in a browser already unlocked with the PIN', async () => {
    await withAppLock(withConnectedX(household('parent')));
    const { unlockAppAction } = await import('@/app/(app)/settings/app-lock-actions');
    expect(await unlockAppAction(PIN)).toEqual({ ok: true });
    const { tree } = await screen();
    expect(has(tree, LOCK_SCREEN)).toBe(false);
    expect(has(tree, 'Rivera fair on X')).toBe(true);
    expect(allByName(tree, 'Disconnect', 'button')).toHaveLength(1);
  });

  it('when the lock setting cannot be read, is shown neither the gate nor the accounts: the app is withheld (closed)', async () => {
    const db = await withAppLock(withConnectedX(household('parent')));
    // The private store's read is refused at its terminal.
    const from = db.from.bind(db);
    db.from = ((table: string) => {
      if (table !== 'app_lock_credentials') return from(table);
      const refused = { select: () => refused, eq: () => refused, abortSignal: () => refused,
        maybeSingle: async () => ({ data: null, error: { message: 'permission denied for table app_lock_credentials', code: '42501' } }) };
      return refused;
    }) as typeof db.from;
    const { tree, gated, showsApp } = await screen();
    expect(gated, 'no dialog: there is no PIN to check, and no gate to show').toBe(false);
    expect(showsApp).toBe(false);
    expect(has(tree, LOCK_UNAVAILABLE)).toBe(true);
    expect(has(tree, LOCK_SCREEN)).toBe(false);
    expect(has(tree, 'Your free trial has ended')).toBe(false);
    expect(has(tree, 'Rivera fair on X')).toBe(false);
    expect(has(tree, LEFT_CONNECTED)).toBe(false);
    expect(allByName(tree, 'Disconnect', 'button')).toHaveLength(0);
  });

  it('with App Lock switched off is shown the accounts and their Disconnect as before (control)', async () => {
    await withAppLock(withConnectedX(household('parent')), false);
    const { tree } = await screen();
    expect(has(tree, LOCK_SCREEN)).toBe(false);
    expect(has(tree, 'Rivera fair on X')).toBe(true);
    expect(allByName(tree, 'Disconnect', 'button')).toHaveLength(1);
  });

  it('with nothing left connected still meets the lock first: the gate itself is behind the PIN', async () => {
    await withAppLock(household('parent'));
    const { tree, sent } = await screen();
    expect(sent(TRIAL_ENDED), 'nothing of the paywall is sent to a locked browser').toBe(false);
    expect(dialogs(tree)).toEqual(['app-lock-title']);
    expect(has(tree, 'Your free trial has ended')).toBe(false);
  });

  it('with an active plan gets the app behind its lock, as before (control)', async () => {
    const db = await withAppLock(withConnectedX(household('parent')));
    db.table('subscriptions')[0].status = 'active';
    const { tree, showsApp, sent } = await screen();
    expect(has(tree, LOCK_SCREEN)).toBe(true);
    expect(showsApp).toBe(false);
    expect(sent(THE_APP), 'the app does not ride along under the lock').toBe(false);
  });
});
