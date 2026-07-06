import { describe, it, expect } from 'vitest';
import { UserCog, Calendar } from 'lucide-react';
import { isNavItemVisibleToRole, type NavItem } from '@/lib/constants/navigation';

const manageItem: NavItem = { href: '/dashboard/family-access', label: 'Kid Logins', icon: UserCog, manage: true };
const openItem: NavItem = { href: '/dashboard/calendar', label: 'Calendar', icon: Calendar };

describe('isNavItemVisibleToRole', () => {
  it('shows non-manage items to everyone', () => {
    expect(isNavItemVisibleToRole(openItem, { isManager: false })).toBe(true);
    expect(isNavItemVisibleToRole(openItem, { isManager: true })).toBe(true);
  });

  it('hides manager-only items from non-managers', () => {
    expect(isNavItemVisibleToRole(manageItem, { isManager: false })).toBe(false);
  });

  it('shows manager-only items to managers', () => {
    expect(isNavItemVisibleToRole(manageItem, { isManager: true })).toBe(true);
  });

  it('always shows manager-only items to super-admins, even without a manager role', () => {
    expect(isNavItemVisibleToRole(manageItem, { isManager: false, isSuperAdmin: true })).toBe(true);
  });
});
