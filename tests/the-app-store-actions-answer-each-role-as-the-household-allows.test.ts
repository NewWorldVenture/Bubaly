// The Family App Store's three writes, called as each member of a household
// and with another household's app ids.
//
// THE POLICY. Nothing in the role model narrows the App Store: the page
// (app/(app)/dashboard/app-store/page.tsx) renders an Install / Installed
// toggle (components/appstore/install-button.tsx) for every signed-in member,
// /dashboard/app-store is neither manager-only navigation nor a guest-withheld
// area (lib/auth/guest-scope.ts), and family_app_installs' live policies are
// `is_family_member(family_id)` for every command (0165_family_app_store.sql:63-73)
// plus 0420's restrictive "only a released app" guard on insert and update
// (0420_only_a_released_app_installs.sql:36-56). So every role of household A
// may install, enable/disable and remove an app FOR HOUSEHOLD A; nobody may
// touch household B's installs; and only a published or beta app installs.
//
// WHAT IS ASSERTED, per role: the action's reply AND the install rows read back
// — A's row written (or toggled, or removed) exactly as promised, B's left as
// it was. And for a cross-family id: refusal, with neither household changed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as unknown,
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db, createServiceClient: () => mocks.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    // requireUserContext redirects a signed-out caller by throwing (lib/supabase/auth.ts).
    if (!mocks.ctx) throw new Error('redirect:/login');
    return mocks.ctx;
  },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { installAppAction, toggleAppAction, uninstallAppAction } = await import('@/app/(app)/dashboard/app-store/actions');

const FAMILY_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-000000000001';
const APP_PUBLISHED = 'a0a0a0a0-0000-4000-8000-000000000001';
const APP_BETA = 'a0a0a0a0-0000-4000-8000-000000000002';
const APP_SOON = 'a0a0a0a0-0000-4000-8000-000000000003';
const APP_ONLY_B = 'a0a0a0a0-0000-4000-8000-000000000004';
const B_MEMBER = 'bbbbbbbb-1111-4000-8000-000000000001';

const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Caller = { role: string; member: string; user: string; email: string };
const CALLERS: Caller[] = [
  ...ROLES.map((role, i) => ({
    role, member: `aaaaaaaa-1111-4000-8000-00000000000${i + 1}`, user: `aaaaaaaa-2222-4000-8000-00000000000${i + 1}`, email: `${role}@example.com`,
  })),
  // A child signed in with a kid PIN: the same membership, a child-login address.
  { role: 'child', member: 'aaaaaaaa-1111-4000-8000-000000000009', user: 'aaaaaaaa-2222-4000-8000-000000000009', email: `kid@${CHILD_LOGIN_EMAIL_DOMAIN}` },
];
const label = (c: Caller) => (c.email.endsWith(CHILD_LOGIN_EMAIL_DOMAIN) ? 'child (kid login)' : c.role);

let db: InMemorySupabase;

function signInAs(c: Caller) {
  mocks.ctx = {
    user: { id: c.user, email: c.email },
    active: { familyId: FAMILY_A, role: c.role, member: { id: c.member }, family: { id: FAMILY_A, timezone: 'UTC' } },
  };
}

const installs = (family: string) => structuredClone(db.table('family_app_installs').filter((r) => r.family_id === family));

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase({ uniques: { family_app_installs: [['family_id', 'app_id']] } });
  mocks.db = db;
  mocks.ctx = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_apps', [
    { id: APP_PUBLISHED, slug: 'published', status: 'published' },
    { id: APP_BETA, slug: 'beta', status: 'beta' },
    { id: APP_SOON, slug: 'soon', status: 'coming_soon' },
    { id: APP_ONLY_B, slug: 'only-b', status: 'published' },
  ]);
  // Household B already has two apps; nothing A does may touch them.
  db.seed('family_app_installs', [
    { family_id: FAMILY_B, app_id: APP_PUBLISHED, installed_by: B_MEMBER, enabled: true },
    { family_id: FAMILY_B, app_id: APP_ONLY_B, installed_by: B_MEMBER, enabled: true },
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe('installAppAction', () => {
  it.each(CALLERS.map((c) => [label(c), c] as const))('ACTION-7B3C7D2E6998 a %s of household A installs a published app for A only', async (_l, c) => {
    signInAs(c);
    const before = installs(FAMILY_B);

    expect(await installAppAction(APP_PUBLISHED)).toEqual({ ok: true });

    expect(installs(FAMILY_A)).toEqual([expect.objectContaining({
      family_id: FAMILY_A, app_id: APP_PUBLISHED, installed_by: c.member, enabled: true, created_by: c.user,
    })]);
    expect(installs(FAMILY_B)).toEqual(before);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/app-store');
  });

  it('ACTION-7B3C7D2E6998 a beta app installs too', async () => {
    signInAs(CALLERS[2]);
    expect(await installAppAction(APP_BETA)).toEqual({ ok: true });
    expect(installs(FAMILY_A).map((r) => r.app_id)).toEqual([APP_BETA]);
  });

  it.each(CALLERS.map((c) => [label(c), c] as const))('ACTION-7B3C7D2E6998 a %s cannot install an app that is not released, and nothing is written', async (_l, c) => {
    signInAs(c);
    const before = structuredClone(db.table('family_app_installs'));

    expect(await installAppAction(APP_SOON)).toEqual({ ok: false, error: 'actions.thatAppIsNotAvailableToInstallYet' });

    expect(db.table('family_app_installs')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-7B3C7D2E6998 installing an app household B has installs a separate row for A and leaves B’s row as it was', async () => {
    signInAs(CALLERS[0]);
    db.table('family_app_installs')[0].enabled = false;
    const before = installs(FAMILY_B);

    expect(await installAppAction(APP_PUBLISHED)).toEqual({ ok: true });

    expect(installs(FAMILY_B)).toEqual(before);
    expect(installs(FAMILY_A)).toHaveLength(1);
  });

  it('ACTION-7B3C7D2E6998 a signed-out caller is sent to sign in and nothing is written', async () => {
    const before = structuredClone(db.table('family_app_installs'));
    await expect(installAppAction(APP_PUBLISHED)).rejects.toThrow('redirect:/login');
    expect(db.table('family_app_installs')).toEqual(before);
  });
});

describe('toggleAppAction', () => {
  beforeEach(() => {
    db.seed('family_app_installs', [{ family_id: FAMILY_A, app_id: APP_PUBLISHED, installed_by: CALLERS[0].member, enabled: true }]);
  });

  it.each(CALLERS.map((c) => [label(c), c] as const))('ACTION-497B5F6177F1 a %s of household A turns A’s install off and on, and B’s is untouched', async (_l, c) => {
    signInAs(c);
    const before = installs(FAMILY_B);

    expect(await toggleAppAction(APP_PUBLISHED, false)).toEqual({ ok: true });
    expect(installs(FAMILY_A)).toEqual([expect.objectContaining({ app_id: APP_PUBLISHED, enabled: false })]);
    expect(installs(FAMILY_B)).toEqual(before);

    expect(await toggleAppAction(APP_PUBLISHED, true)).toEqual({ ok: true });
    expect(installs(FAMILY_A)).toEqual([expect.objectContaining({ app_id: APP_PUBLISHED, enabled: true })]);
    expect(installs(FAMILY_B)).toEqual(before);
  });

  it.each(CALLERS.map((c) => [label(c), c] as const))('ACTION-497B5F6177F1 a %s naming an app only household B installed is refused and neither household changes', async (_l, c) => {
    signInAs(c);
    const before = structuredClone(db.table('family_app_installs'));

    expect(await toggleAppAction(APP_ONLY_B, false)).toEqual({ ok: false, error: 'actions.couldNotUpdateThatApp' });

    expect(db.table('family_app_installs')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('uninstallAppAction', () => {
  beforeEach(() => {
    db.seed('family_app_installs', [{ family_id: FAMILY_A, app_id: APP_PUBLISHED, installed_by: CALLERS[0].member, enabled: true }]);
  });

  it.each(CALLERS.map((c) => [label(c), c] as const))('ACTION-76DF090DECE9 a %s of household A removes A’s install and only A’s', async (_l, c) => {
    signInAs(c);
    const before = installs(FAMILY_B);

    expect(await uninstallAppAction(APP_PUBLISHED)).toEqual({ ok: true });

    expect(installs(FAMILY_A)).toEqual([]);
    expect(installs(FAMILY_B)).toEqual(before);
    expect(installs(FAMILY_B).map((r) => r.app_id)).toEqual([APP_PUBLISHED, APP_ONLY_B]);
  });

  it.each(CALLERS.map((c) => [label(c), c] as const))('ACTION-76DF090DECE9 a %s naming an app only household B installed is refused and neither household changes', async (_l, c) => {
    signInAs(c);
    const before = structuredClone(db.table('family_app_installs'));

    expect(await uninstallAppAction(APP_ONLY_B)).toEqual({ ok: false, error: 'actions.couldNotRemoveThatApp' });

    expect(db.table('family_app_installs')).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-76DF090DECE9 a signed-out caller is sent to sign in and nothing is removed', async () => {
    const before = structuredClone(db.table('family_app_installs'));
    await expect(uninstallAppAction(APP_PUBLISHED)).rejects.toThrow('redirect:/login');
    expect(db.table('family_app_installs')).toEqual(before);
  });
});
