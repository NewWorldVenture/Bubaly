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

/** Human label for a given view + role (used in the switcher and settings). */
export function dashboardLabel(view: DashboardView, role: MemberRole): string {
  return view === 'family' ? FAMILY_DASHBOARD_LABEL : personalDashboardLabel(role);
}

export const dashboardIcon: Record<DashboardView, LucideIcon> = {
  personal: UserRound,
  family: LayoutDashboard,
};

/** Short description for the settings selector. */
export const DASHBOARD_DESCRIPTIONS: Record<DashboardView, string> = {
  personal: 'Your role-specific view: your day, your tasks, and what needs you.',
  family: 'The shared Command Center — everyone’s schedule, chores, and meals.',
};
