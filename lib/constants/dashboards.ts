// Dashboard views available to every signed-in member.
//
// Each member has a role-specific *personal* dashboard (their default) and can
// also open the shared *family* dashboard (the Command Center overview). The
// chosen default is stored per user in user_preferences.default_dashboard.

import { LayoutDashboard, UserRound, type LucideIcon } from 'lucide-react';
import type { DashboardView } from '@/lib/database.types';
import type { MemberRole } from './roles';

export type { DashboardView } from '@/lib/database.types';

export const DASHBOARD_VIEWS: DashboardView[] = ['personal', 'family'];

export const isDashboardView = (v: unknown): v is DashboardView =>
  v === 'personal' || v === 'family';

/** Title shown for a member's personal (role-specific) dashboard. */
const PERSONAL_LABELS: Record<MemberRole, string> = {
  parent: 'Parent Dashboard',
  adult: 'My Dashboard',
  teen: 'My Dashboard',
  child: 'My Dashboard',
  caregiver: 'Caregiver Dashboard',
  guest: 'My Dashboard',
};

export function personalDashboardLabel(role: MemberRole): string {
  return PERSONAL_LABELS[role] ?? 'My Dashboard';
}

export const FAMILY_DASHBOARD_LABEL = 'Family Dashboard';

/** The English name for a given view + role. It is a navigation label: a
 *  screen shows `navLabel(t, dashboardLabel(view, role))`. */
export function dashboardLabel(view: DashboardView, role: MemberRole): string {
  return view === 'family' ? FAMILY_DASHBOARD_LABEL : personalDashboardLabel(role);
}

export const dashboardIcon: Record<DashboardView, LucideIcon> = {
  personal: UserRound,
  family: LayoutDashboard,
};

/** Catalogue key of the short description for the settings selector. */
export const DASHBOARD_DESCRIPTION_KEYS: Record<DashboardView, string> = {
  personal: 'dashboards.personalDescription',
  family: 'dashboards.familyDescription',
};
