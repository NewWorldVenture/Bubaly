// Two pages a guest reached and read through RLS that 0481 narrows for them:
//
//   /dashboard/family/find-phone reads member_locations and family_places.
//   0481 returns a guest only their own location row and no places, so every
//   other member's card said "Location sharing is off for this member.", true
//   of nobody, and the guest's own row fell to "No recent location".
//
//   /dashboard/renewals reads renewals, which 0481's restrictive
//   renewals_not_a_guests_read returns a guest none of, and the page said
//   "Nothing tracked yet — No renewals have been added yet."
//
// Both are now withheld from a guest the way the locator and driving-safety
// pages already are (lib/auth/guest-scope.ts), and are not offered in the
// guest's navigation. Driven through the real pages, the real
// requireUserContext / requireFeature and the real guest scope, with the
// session's membership read from the in-memory database.
import { isValidElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-00000000c901';
const GUEST_USER = '00000000-0000-4000-8000-00000000c911';
const PARENT_USER = '00000000-0000-4000-8000-00000000c912';

const h = vi.hoisted(() => ({ db: null as unknown, redirects: [] as string[] }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { h.redirects.push(to); throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` }); },
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
// The plan resolver has its own tests; the family is entitled to Renewals.
vi.mock('@/lib/server/feature-entitlement', () => ({ resolveFeatureEntitlement: async () => ({ allowed: true, planLevel: 2 }) }));
vi.mock('@/components/family/find-phone-view', () => ({ FindPhoneView: () => null }));
vi.mock('@/components/modules/renewals-module', () => ({ RenewalsModule: () => null }));

const { default: FindPhonePage } = await import('@/app/(app)/dashboard/family/find-phone/page');
const { default: RenewalsPage } = await import('@/app/(app)/dashboard/renewals/page');
const { FindPhoneView } = await import('@/components/family/find-phone-view');
const { RenewalsModule } = await import('@/components/modules/renewals-module');
const { GUEST_LANDING } = await import('@/lib/auth/guest-scope');
const { isNavItemVisibleToRole } = await import('@/lib/constants/navigation');

let db: InMemorySupabase;
function signedInAs(userId: string) {
  db = createInMemorySupabase({ userId, rpc: { is_super_admin: () => false } });
  h.db = db;
  db.seed('families', [{ id: FAMILY, name: 'The Okafors', timezone: 'UTC', closed_at: null }]);
  db.seed('family_members', [
    { id: 'm-guest', family_id: FAMILY, user_id: GUEST_USER, role: 'guest', is_active: true, display_name: 'Grandma' },
    { id: 'm-parent', family_id: FAMILY, user_id: PARENT_USER, role: 'parent', is_active: true, display_name: 'Ada' },
  ]);
}

beforeEach(() => { h.redirects = []; });

const renders = (out: unknown, component: unknown) => isValidElement(out) && (out as ReactElement).type === component;

describe('Find Phone', () => {
  it('sends a guest to their own landing page instead of telling them sharing is off for everyone', async () => {
    signedInAs(GUEST_USER);
    await expect(FindPhonePage()).rejects.toThrow('NEXT_REDIRECT');
    expect(h.redirects).toEqual([GUEST_LANDING]);
  });

  it('control: still renders for a parent', async () => {
    signedInAs(PARENT_USER);
    expect(renders(await FindPhonePage(), FindPhoneView)).toBe(true);
    expect(h.redirects).toEqual([]);
  });
});

describe('Renewals', () => {
  it('sends a guest to their own landing page instead of saying nothing has been added', async () => {
    signedInAs(GUEST_USER);
    await expect(RenewalsPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(h.redirects).toEqual([GUEST_LANDING]);
  });

  it('control: still renders for a parent', async () => {
    signedInAs(PARENT_USER);
    expect(renders(await RenewalsPage(), RenewalsModule)).toBe(true);
    expect(h.redirects).toEqual([]);
  });
});

describe('the navigation', () => {
  it.each(['/dashboard/family/find-phone', '/dashboard/renewals'])('does not offer %s to a guest, and still does to everyone else', (href) => {
    const item = { href, label: href, icon: (() => null) as never };
    expect(isNavItemVisibleToRole(item, { isManager: false, isGuest: true })).toBe(false);
    expect(isNavItemVisibleToRole(item, { isManager: false, isGuest: false })).toBe(true);
    expect(isNavItemVisibleToRole(item, { isManager: true })).toBe(true);
  });
});
