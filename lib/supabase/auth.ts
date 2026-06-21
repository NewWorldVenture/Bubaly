// Server-side auth + active-family resolution. Used by every protected page/layout.
import { redirect } from 'next/navigation';
import { createServer } from './server';
import { isSuperAdminEmail } from '@/lib/constants/super-admins';
import { planLevel } from '@/lib/constants/plans';
import type { MemberRole } from '@/lib/constants/roles';
import type { Tables } from '@/lib/database.types';

export type FamilyMembership = {
  familyId: string;
  family: Tables<'families'>;
  role: MemberRole;
  member: Tables<'family_members'>;
};

export type UserContext = {
  user: { id: string; email: string | null };
  memberships: FamilyMembership[];
  active: FamilyMembership;
};

/** Returns the signed-in user or null. */
export async function getUser() {
  const supabase = await createServer();
  const { data } = await supabase.auth.getUser();
  return data.user;
}

/**
 * True only for the site-wide Super Administrator (matched by email against the
 * super_admins allowlist, independent of family membership). Unlike family roles,
 * this grants oversight of the whole site, not a single household — use sparingly.
 */
export async function isSuperAdmin(): Promise<boolean> {
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return false;
  // Code/env allowlist first — works even if the super_admins migration (0008)
  // hasn't been applied to this database yet.
  if (isSuperAdminEmail(auth.user.email)) return true;
  const { data } = await supabase.rpc('is_super_admin');
  return data === true;
}

/**
 * Resolves the full user + active-family context. Returns null when not signed in,
 * or { needsFamily: true } when signed in but not yet in any family.
 */
export async function getUserContext(): Promise<UserContext | { needsFamily: true } | null> {
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;

  const { data: members } = await supabase
    .from('family_members')
    .select('*')
    .eq('user_id', auth.user.id)
    .eq('is_active', true);

  const rows = members ?? [];
  if (rows.length === 0) return { needsFamily: true };

  const familyIds = rows.map((m) => m.family_id);
  const { data: families } = await supabase.from('families').select('*').in('id', familyIds);
  const byId = new Map((families ?? []).map((f) => [f.id, f]));

  const memberships: FamilyMembership[] = rows
    .map((m) => {
      const family = byId.get(m.family_id);
      return family
        ? { familyId: m.family_id, family, role: m.role as MemberRole, member: m }
        : null;
    })
    .filter((m): m is FamilyMembership => m !== null);

  if (memberships.length === 0) return { needsFamily: true };

  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('active_family_id')
    .eq('user_id', auth.user.id)
    .maybeSingle();

  const active =
    memberships.find((m) => m.familyId === prefs?.active_family_id) ?? memberships[0];

  return {
    user: { id: auth.user.id, email: auth.user.email ?? null },
    memberships,
    active,
  };
}

/** Guard for app pages: redirects to /login or /onboarding as needed. */
export async function requireUserContext(): Promise<UserContext> {
  const ctx = await getUserContext();
  if (!ctx) redirect('/login');
  if ('needsFamily' in ctx) redirect('/onboarding');
  return ctx;
}

/**
 * Guard for plan-gated pages. Calls requireUserContext, then checks the
 * family subscription plan. If the plan level is below `minLevel`, redirects
 * to /dashboard/billing with an `upgrade=1` query param.
 *
 * minLevel: 0 = free (any), 1 = basic+, 2 = plus+
 */
export async function requirePlanLevel(minLevel: 1 | 2): Promise<UserContext> {
  const ctx = await requireUserContext();

  // Super administrators are never plan-gated — they can access every page,
  // regardless of their family's subscription. Everyone else is checked below.
  if (await isSuperAdmin()) return ctx;

  const supabase = await createServer();
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('plan, status')
    .eq('family_id', ctx.active.familyId)
    .in('status', ['active', 'trialing'])
    .maybeSingle();

  const level = planLevel(sub?.plan ?? null);
  if (level < minLevel) {
    redirect('/dashboard/billing?upgrade=1');
  }
  return ctx;
}
