// App Lock is enforced on the server (claim 6353616068, follow-up on #771).
//
// It was enforced only in the browser. app/(app)/layout.tsx handed the client
// gate the PIN's `salt` and `hash` from notification_prefs.appLock, and the
// gate ran verifyPin itself, so:
//   1. both sat in the RSC payload, and anyone holding the device could read
//      them and try the 10,000 PINs offline;
//   2. the five-tries-then-30-seconds limit was React state — a reload reset it;
//   3. `children`, the whole page, was rendered into the payload underneath the
//      overlay, whatever the gate's comment said about "before any content".
//
// Now the layout reads an unlock cookie and, without a valid one for THIS
// user and THIS PIN, renders the lock screen alone. unlockAppAction checks the
// PIN on the server against a durable, caller-keyed attempt limit and sets the
// cookie. Driven through the REAL layout and the REAL actions against the
// in-memory database, with a cookie jar standing in for next/headers. The gate
// is a marker here, so what the layout hands the browser can be read off the
// tree: everything passed to a client component is serialised into the payload.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import { buildAppLockConfig, type AppLockConfig } from '@/lib/security/app-lock';

type Cookie = { value: string; options: Record<string, unknown> };
const state = vi.hoisted(() => ({
  db: null as unknown,
  userId: null as string | null,
  jar: new Map<string, { value: string; options: Record<string, unknown> }>(),
  limiterKeys: [] as string[],
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => { state.jar.set(name, { value, options }); },
    delete: (arg: string | { name: string }) => { state.jar.delete(typeof arg === 'string' ? arg : arg.name); },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({
  isSuperAdmin: async () => false,
  requireUserContext: async () => {
    if (!state.userId) throw new Error('NEXT_REDIRECT /login');
    return { user: { id: state.userId } };
  },
}));
vi.mock('@/lib/server/family-time-zone', () => ({ activeFamilyTimeZone: async () => 'UTC' }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/components/i18n/locale-provider', () => ({ FamilyTimeZoneProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/i18n/scoped-locale-provider', () => ({ ScopedLocaleProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/ui/confirm', () => ({ ConfirmProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/auth/session-keeper', () => ({ SessionKeeper: (props: object) => createElement('session-keeper', props) }));
vi.mock('@/components/app/app-lock-gate', () => ({ AppLockGate: (props: object) => createElement('app-lock-gate', props) }));
vi.mock('@/components/app/trial-paywall-gate', () => ({ TrialPaywallGate: (props: object) => createElement('paywall-gate', props) }));
vi.mock('@/components/app/account-closed-gate', () => ({ AccountClosedGate: (props: object) => createElement('closed-gate', props) }));

const { default: AppGroupLayout } = await import('@/app/(app)/layout');
const actions = () => import('@/app/(app)/settings/app-lock-actions');

const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const ANA = '00000000-0000-4000-8000-0000000000a1';
const BEN = '00000000-0000-4000-8000-0000000000b2';
const PIN = '4071';

type Db = ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let db: Db;
const locks: Record<string, AppLockConfig> = {};

/** rate_limit_hit as 0179 has it: a signed-in caller's key must name them, or the call raises. */
function limiter(args: Record<string, unknown>, fake: Parameters<typeof rateLimitHit>[1]) {
  const key = String(args.p_key);
  state.limiterKeys.push(key);
  if (state.userId && !new RegExp(`(^|:)${state.userId}(:|$)`).test(key)) throw new Error('rate limit key must name the caller');
  return rateLimitHit(args, fake);
}

function household() {
  db = createInMemorySupabase<SupabaseClient<Database>>({ userId: ANA, rpc: { rate_limit_hit: limiter } });
  db.seed('families', [{ id: FAMILY, name: 'House', timezone: 'UTC', trial_ends_at: null, closed_at: null }]);
  db.seed('family_members', [
    { id: 'm-ana', family_id: FAMILY, user_id: ANA, role: 'parent', is_active: true, created_at: '2026-01-01T00:00:00Z' },
    { id: 'm-ben', family_id: FAMILY, user_id: BEN, role: 'parent', is_active: true, created_at: '2026-01-02T00:00:00Z' },
  ]);
  db.seed('user_preferences', [
    { user_id: ANA, notification_prefs: { appLock: locks.ana, email: true }, updated_at: '2026-10-01T00:00:00Z' },
    { user_id: BEN, notification_prefs: { appLock: locks.ben }, updated_at: '2026-10-01T00:00:00Z' },
  ]);
  state.db = db;
  signIn(ANA);
}

/** The browser signs in as `userId`: same cookie jar, a different session. */
function signIn(userId: string | null) {
  state.userId = userId;
  (db as unknown as { options: { userId: string | null } }).options.userId = userId;
}

const prefsOf = (userId: string) => db.table('user_preferences').find((r) => r.user_id === userId)!.notification_prefs as Record<string, unknown>;

/** Call every function component — the async server ones included — until only host elements remain. */
async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree));
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  const { type, props } = node as ReactElement<Record<string, unknown>>;
  if (typeof type === 'function') return resolveTree(await (type as (p: unknown) => ReactNode | Promise<ReactNode>)(props));
  const { children, ...rest } = props;
  if (children === undefined) return node;
  return createElement(type as string, rest, await resolveTree(children as ReactNode));
}

function find(tree: ReactNode, type: string): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(tree)) { for (const child of tree) { const hit = find(child, type); if (hit) return hit; } return null; }
  if (!isValidElement<Record<string, unknown>>(tree)) return null;
  if (tree.type === type) return tree;
  return find(tree.props.children as ReactNode, type);
}

/** Everything the render hands on — props included — as one string, the way the payload carries it. */
const payload = (tree: ReactNode) => JSON.stringify(tree);

async function render() {
  const tree = await resolveTree(await AppGroupLayout({ children: 'THE-APP' }));
  return { tree, gate: find(tree, 'app-lock-gate'), app: payload(tree).includes('THE-APP'), text: payload(tree) };
}

beforeEach(async () => {
  locks.ana = await buildAppLockConfig(PIN);
  locks.ben = await buildAppLockConfig(PIN); // the same PIN, on purpose
  state.jar.clear();
  state.limiterKeys = [];
  // Each case starts with a fresh process-local limiter (lib/server/rate-limit
  // keeps its count in module scope), as the database does with a fresh fake.
  vi.resetModules();
  household();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the (app) layout decides App Lock on the server', () => {
  it('a locked browser is sent the lock screen alone: no app, no salt, no hash', async () => {
    const page = await render();
    expect(page.gate, 'the lock screen is rendered').not.toBeNull();
    // Soft, so a regression reports every one of the three leaks at once.
    expect.soft(page.text, 'the salt must not reach the browser').not.toContain(locks.ana.salt);
    expect.soft(page.text, 'the hash must not reach the browser').not.toContain(locks.ana.hash);
    expect.soft(page.app, 'the page must not ride along under the overlay').toBe(false);
    // The session keeper still runs outside the gate, so unlocking lands on a live session.
    expect(find(page.tree, 'session-keeper')).not.toBeNull();
  });

  it('a browser that unlocked with the PIN sees the app, and no lock screen', async () => {
    const { unlockAppAction } = await actions();
    expect(await unlockAppAction(PIN)).toEqual({ ok: true });
    const page = await render();
    expect(page.gate).toBeNull();
    expect(page.app).toBe(true);
  });

  it("one user's unlock does not unlock another account on the same browser, even with the same PIN", async () => {
    const { unlockAppAction } = await actions();
    expect(await unlockAppAction(PIN)).toEqual({ ok: true });
    signIn(BEN);
    const page = await render();
    expect(page.gate).not.toBeNull();
    expect(page.app).toBe(false);
  });

  it("an unlock re-labelled with another user's id unlocks nobody", async () => {
    const { unlockAppAction } = await actions();
    await unlockAppAction(PIN);
    const [name, cookie] = [...state.jar.entries()][0];
    state.jar.set(name, { ...cookie, value: cookie.value.replace(ANA, BEN) });
    signIn(BEN);
    expect((await render()).app).toBe(false);
  });

  it('a new PIN set elsewhere locks a browser that unlocked with the old one', async () => {
    const { unlockAppAction } = await actions();
    await unlockAppAction(PIN);
    prefsOf(ANA).appLock = await buildAppLockConfig('9090');
    const page = await render();
    expect(page.gate).not.toBeNull();
    expect(page.app).toBe(false);
  });

  it('with the lock off the app renders, unlock or no unlock (control)', async () => {
    prefsOf(ANA).appLock = { ...locks.ana, enabled: false };
    const page = await render();
    expect(page.gate).toBeNull();
    expect(page.app).toBe(true);
  });
});

describe('unlockAppAction checks the PIN on the server', () => {
  it('refuses a wrong PIN and sets no unlock', async () => {
    const { unlockAppAction } = await actions();
    expect(await unlockAppAction('1111')).toEqual({ ok: false, reason: 'wrong_pin' });
    expect(await unlockAppAction('not a pin')).toEqual({ ok: false, reason: 'wrong_pin' });
    expect(state.jar.size).toBe(0);
  });

  it('a right PIN sets an httpOnly, SameSite=Lax cookie with no Max-Age, naming the user', async () => {
    const { unlockAppAction } = await actions();
    expect(await unlockAppAction(PIN)).toEqual({ ok: true });
    expect(state.jar.size).toBe(1);
    const [, cookie] = [...state.jar.entries()][0] as [string, Cookie];
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    // Session-scoped: the browser drops it when it closes.
    expect(cookie.options).not.toHaveProperty('maxAge');
    expect(cookie.options).not.toHaveProperty('expires');
    expect(cookie.value.startsWith(`${ANA}.`)).toBe(true);
    expect(cookie.value).not.toContain(locks.ana.hash);
    expect(cookie.value).not.toContain(PIN);
  });

  it('after five tries even the right PIN waits, and the count survives a fresh server', async () => {
    const { unlockAppAction } = await actions();
    for (let i = 0; i < 5; i++) expect(await unlockAppAction('0000')).toEqual({ ok: false, reason: 'wrong_pin' });
    const refused = await unlockAppAction(PIN);
    expect(refused).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect((refused as { retryAfter: number }).retryAfter).toBeGreaterThan(0);

    // A new instance — no process-local count at all — still refuses: the
    // count is in the database, not in the browser and not in this process.
    vi.resetModules();
    const fresh = await actions();
    expect(await fresh.unlockAppAction(PIN)).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(state.jar.size).toBe(0);

    // Every hit was keyed on the caller's own id (rate_limit_hit raises otherwise).
    expect(state.limiterKeys.length).toBeGreaterThanOrEqual(6);
    for (const key of state.limiterKeys) expect(key).toMatch(new RegExp(`(^|:)${ANA}$`));
  });

  it("one user's spent tries do not lock another user out", async () => {
    const { unlockAppAction } = await actions();
    for (let i = 0; i < 6; i++) await unlockAppAction('0000');
    signIn(BEN);
    expect(await unlockAppAction(PIN)).toEqual({ ok: true });
  });

  it('a signed-out caller is refused before anything is counted or set', async () => {
    const { unlockAppAction } = await actions();
    signIn(null);
    expect(await unlockAppAction(PIN)).toEqual({ ok: false, reason: 'unavailable' });
    expect(state.limiterKeys).toEqual([]);
    expect(state.jar.size).toBe(0);
  });
});

describe('the settings flows keep the unlock in step', () => {
  it('turning the lock on keeps this browser in the app', async () => {
    prefsOf(ANA).appLock = { ...locks.ana, enabled: false };
    const { saveAppLockConfig } = await actions();
    expect(await saveAppLockConfig({ ...locks.ana, enabled: true })).toEqual({ ok: true });
    expect((await render()).app).toBe(true);
  });

  it('a new PIN keeps this browser in, and locks a browser that unlocked with the old one', async () => {
    const { unlockAppAction, saveAppLockConfig } = await actions();
    await unlockAppAction(PIN);
    const otherBrowser = new Map(state.jar);
    const next = await buildAppLockConfig('9090');
    expect(await saveAppLockConfig(next)).toEqual({ ok: true });
    expect(prefsOf(ANA)).toMatchObject({ appLock: next, email: true });
    expect((await render()).app, 'this browser').toBe(true);

    state.jar.clear();
    for (const [k, v] of otherBrowser) state.jar.set(k, v);
    expect((await render()).app, 'the other browser').toBe(false);
  });

  it('turning the lock off drops the unlock', async () => {
    const { unlockAppAction, saveAppLockConfig } = await actions();
    await unlockAppAction(PIN);
    expect(await saveAppLockConfig({ ...locks.ana, enabled: false })).toEqual({ ok: true });
    expect(state.jar.size).toBe(0);
    expect((await render()).app).toBe(true);
  });

  it('a locked browser cannot turn the lock off or set a PIN of its own', async () => {
    const { saveAppLockConfig } = await actions();
    expect(await saveAppLockConfig(null)).toMatchObject({ ok: false });
    expect(await saveAppLockConfig(await buildAppLockConfig('1234'))).toMatchObject({ ok: false });
    expect(prefsOf(ANA).appLock).toEqual(locks.ana);
    expect(state.jar.size).toBe(0);
    expect((await render()).app).toBe(false);
  });

  it('"Lock now" drops the unlock, and the next render is the lock screen', async () => {
    const { unlockAppAction, lockAppAction } = await actions();
    await unlockAppAction(PIN);
    expect((await render()).app).toBe(true);
    await lockAppAction();
    const page = await render();
    expect(page.gate).not.toBeNull();
    expect(page.app).toBe(false);
  });
});
