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
import { allByName, byName, click, has, nodes, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const server = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as unknown as { user: { id: string; email: string | null }; memberships: unknown[]; active: Record<string, unknown> & { familyId: string } },
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
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
  SignOutForm: ({ children }: { children: (s: { signingOut: boolean }) => unknown }) => children({ signingOut: false }),
}));
// The gates' own actions are not what this is about.
vi.mock('@/app/(app)/account/actions', () => ({
  closeAccountAction: async () => { throw new Error('not under test'); },
  reopenAccountAction: async () => { throw new Error('not under test'); },
}));
vi.mock('@/app/(app)/actions', () => ({ setActiveFamilyAction: async () => ({ ok: true }) }));

// The server side: the layout's surroundings, and what the disconnect action needs.
vi.mock('next/cache', () => ({ revalidatePath() {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set() {} }) }));
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
vi.mock('@/components/app/app-lock-gate', () => ({ AppLockGate: ({ children }: { children: ReactNode }) => children }));

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
  const db = createInMemorySupabase({ userId: USERS[who], maxRows: 1000 });
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
  const tree = render(h.hooks, (await resolveServer(await AppGroupLayout({ children: THE_APP }))) as ReactElement);
  const gates = nodes(tree).filter((node) => node.props.role === 'dialog');
  return { tree, gated: gates.length > 0, showsApp: has(tree, THE_APP) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('window', { confirm: () => true, location: { assign() {}, reload() {}, pathname: '/home', search: '' }, addEventListener() {}, removeEventListener() {} });
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
