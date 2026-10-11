import { describe, expect, it, vi } from 'vitest';
import { Calendar } from 'lucide-react';
import { isNavItemVisibleToRole, type NavItem } from '@/lib/constants/navigation';
const redirect = vi.hoisted(() => vi.fn((path: string) => { throw new Error('NEXT_REDIRECT ' + path); }));
vi.mock('next/navigation', () => ({ redirect }));
import { GUEST_LANDING, GUEST_WITHHELD_PREFIXES, refuseGuest } from '@/lib/auth/guest-scope';
const item = (href: string, manage = false): NavItem => ({ href, label: href, icon: Calendar, manage });
const ctx = (role: string) => ({ active: { role } }) as Parameters<typeof refuseGuest>[0];

describe('guest navigation obeys the unchanged active-family page boundary', () => {
  it.each(GUEST_WITHHELD_PREFIXES)('%s: a super-admin guest receives neither the link nor the page', (href) => {
    expect(() => refuseGuest(ctx('guest'), href)).toThrow('NEXT_REDIRECT ' + GUEST_LANDING);
    expect(isNavItemVisibleToRole(item(href), { isGuest: true, isManager: false, isSuperAdmin: true })).toBe(false);
    expect(isNavItemVisibleToRole(item(href), { isGuest: true, isManager: true, isSuperAdmin: true })).toBe(false);
  });
  it('a withheld child page follows the same active-family guest guard', () => {
    const href = '/wallet/children/synthetic-child';
    expect(() => refuseGuest(ctx('guest'), href)).toThrow('NEXT_REDIRECT ' + GUEST_LANDING);
    expect(isNavItemVisibleToRole(item(href), { isGuest: true, isManager: false, isSuperAdmin: true })).toBe(false);
  });
  it.each(['/dashboard/calendar', '/dashboard/emergency', GUEST_LANDING])('%s: shared destinations remain open to a guest', (href) => {
    expect(() => refuseGuest(ctx('guest'), href)).not.toThrow();
    expect(isNavItemVisibleToRole(item(href), { isGuest: true, isManager: false, isSuperAdmin: true })).toBe(true);
  });
  it('a non-guest super-admin keeps the existing manager-only navigation bypass', () => {
    expect(isNavItemVisibleToRole(item('/dashboard/family-access', true), { isGuest: false, isManager: false, isSuperAdmin: true })).toBe(true);
    expect(isNavItemVisibleToRole(item('/dashboard/family-access', true), { isGuest: false, isManager: false, isSuperAdmin: false })).toBe(false);
  });
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver'])('%s: non-guest page and navigation treatment is unchanged', (role) => {
    expect(() => refuseGuest(ctx(role), '/dashboard/locator')).not.toThrow();
    expect(isNavItemVisibleToRole(item('/dashboard/locator'), { isGuest: false, isManager: role === 'parent' || role === 'adult', isSuperAdmin: true })).toBe(true);
  });
  it.each(['/wallets', '/dashboard/healthy-recipes'])('%s is not widened into the withheld prefix', (href) => {
    expect(() => refuseGuest(ctx('guest'), href)).not.toThrow();
    expect(isNavItemVisibleToRole(item(href), { isGuest: true, isManager: false, isSuperAdmin: true })).toBe(true);
  });
});
