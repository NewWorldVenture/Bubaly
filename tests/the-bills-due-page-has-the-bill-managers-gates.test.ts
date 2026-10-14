// N1 — /dashboard/due rendered every unpaid household bill and the total due
// (BillsView mode="due") behind requireUserContext alone. Its two siblings that
// render the same component, /dashboard/bills and /dashboard/autopay, refuse a
// guest and send a manager whose authenticator is enrolled to step-up. The held
// 0509 still returns bills to a guest, so the page is the only gate there is.
//
// Driven through the real page: the real guest-scope and require-aal2 guards,
// with the session's role and assurance level as the only inputs.
import { createElement, isValidElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'parent',
  getAal: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    mocks.redirect(to);
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'p@example.com' },
    memberships: [],
    active: { familyId: 'fam-1', role: mocks.role, member: { id: 'mem-1' }, family: { id: 'fam-1', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ auth: { mfa: { getAuthenticatorAssuranceLevel: mocks.getAal } } }),
}));
// The list itself reads through the browser client; what is under test is
// whether the page hands it to this session at all.
vi.mock('@/components/finance/bills-view', () => ({ BillsView: (props: { mode: string }) => createElement('section', { 'data-bills': props.mode }) }));

const { default: DuePage } = await import('@/app/(app)/dashboard/due/page');
const { GUEST_LANDING, isWithheldFromGuest } = await import('@/lib/auth/guest-scope');
const { isNavItemVisibleToRole } = await import('@/lib/constants/navigation');

const NO_FACTOR = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
const ENROLLED_NO_CODE_YET = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
const CODE_ENTERED = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };

beforeEach(() => {
  mocks.redirect.mockReset();
  mocks.getAal.mockReset();
  mocks.role = 'parent';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const { BillsView } = await import('@/components/finance/bills-view');
const billsShown = (out: unknown) => isValidElement(out)
  && (out as ReactElement<{ mode?: string }>).type === BillsView && (out as ReactElement<{ mode?: string }>).props.mode === 'due';

describe('/dashboard/due', () => {
  it('sends a guest to their own landing page before any bill is rendered', async () => {
    mocks.role = 'guest';
    mocks.getAal.mockResolvedValue(NO_FACTOR);
    await expect(DuePage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith(GUEST_LANDING);
  });

  it('sends a manager with an enrolled authenticator and no code this session to step-up, returning here', async () => {
    mocks.getAal.mockResolvedValue(ENROLLED_NO_CODE_YET);
    await expect(DuePage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith('/auth/step-up?next=%2Fdashboard%2Fdue');
  });

  it('renders the bills for a manager who entered the code, and for a family with no authenticator', async () => {
    mocks.getAal.mockResolvedValue(CODE_ENTERED);
    expect(billsShown(await DuePage())).toBe(true);
    mocks.getAal.mockResolvedValue(NO_FACTOR);
    expect(billsShown(await DuePage())).toBe(true);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('is not offered to a guest in the navigation, and still is to everyone else', () => {
    expect(isWithheldFromGuest('/dashboard/due')).toBe(true);
    const item = { href: '/dashboard/due', label: 'Due Reminders', icon: (() => null) as never };
    expect(isNavItemVisibleToRole(item, { isManager: false, isGuest: true })).toBe(false);
    expect(isNavItemVisibleToRole(item, { isManager: false, isGuest: false })).toBe(true);
    expect(isNavItemVisibleToRole(item, { isManager: true })).toBe(true);
  });
});
