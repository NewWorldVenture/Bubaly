import { redirect } from 'next/navigation';
import type { UserContext } from '@/lib/supabase/auth';

/**
 * The household areas a guest does not see (the owner's decision on
 * ROLE-SCOPE-001, held 0509): live and historical locations, money and cards,
 * medical and insurance records, Guardian and the household inbox. The held
 * 0509 refuses a guest the rows behind these pages; this sends a guest to
 * their own landing page instead of rendering the page empty. Tax is 0508's
 * (/dashboard/tax-vault tells every non-manager it is the parents').
 *
 * A caregiver is not narrowed: a babysitter needs the children's whereabouts
 * and medical information. Calendar, lists, meals, chores, the family chat,
 * rides, emergency contacts and the other shared areas stay open to a guest.
 */
export const GUEST_LANDING = '/dashboard/grandparent-portal';

export const GUEST_WITHHELD_PREFIXES = [
  // locations
  '/dashboard/locator',
  '/dashboard/family/check-in',
  '/dashboard/family/driving-safety',
  // money and cards
  '/dashboard/autopay',
  '/dashboard/billing',
  '/dashboard/bills',
  '/dashboard/budgets',
  '/dashboard/expenses',
  '/dashboard/family-cfo',
  '/dashboard/money-timeline',
  '/dashboard/payments',
  '/dashboard/savings',
  '/dashboard/subscriptions',
  '/wallet',
  // medical and insurance
  '/dashboard/medical',
  '/dashboard/medications',
  '/dashboard/health',
  '/dashboard/family-health',
  '/dashboard/care',
  '/dashboard/behavior',
  '/dashboard/insurance',
  '/dashboard/auto/insurance',
  // Guardian and the household inbox
  '/guardian',
  '/dashboard/inbox',
] as const;

/** True when `path` is one of the withheld pages or below one. */
export function isWithheldFromGuest(path: string): boolean {
  return GUEST_WITHHELD_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Sends a guest of the active household away from a withheld page. Everyone else passes. */
export function refuseGuest(ctx: Pick<UserContext, 'active'>, path: string): void {
  if (ctx.active.role === 'guest' && isWithheldFromGuest(path)) redirect(GUEST_LANDING);
}
