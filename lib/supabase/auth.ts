// Server-side auth + active-family resolution. Used by every protected page/layout.
import { redirect, notFound } from 'next/navigation';
import { createServer } from './server';
import { isSuperAdminEmail } from '@/lib/constants/super-admins';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { tierToLevel } from '@/lib/features/tiers';
import { getFeatureTiersByHref } from '@/lib/server/feature-tiers';
import { ensureActiveFamily } from '@/lib/server/ensure-family';
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

function throwContextUnavailable(scope: string, error: unknown): never {
  console.error(`[auth] ${scope} query failed`, error);
  throw new Error('Account context is temporarily unavailable.');
}

/**
 * Supabase reports an anonymous visitor as an AuthSessionMissingError from
 * `auth.getUser()`. That is the normal signed-out state on every public page,
 * not a failure, so it must not be logged as one.
 */
function isSessionMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; message?: unknown; code?: unknown };
  return e.name === 'AuthSessionMissingError' || e.code === 'session_missing' || (typeof e.message === 'string' && /auth session missing/i.test(e.message));
}

/** Returns the signed-in user or null. */
export async function getUser() {
  const supabase = await createServer();
  const { data, error } = await supabase.auth.getUser();
  if (error && !isSessionMissing(error)) console.error('[auth] user lookup failed', error);
  return data.user;
}

/**
 * True only for the site-wide Super Administrator (matched by email against the
 * super_admins allowlist, independent of family membership). Unlike family roles,
 * this grants oversight of the whole site, not a single household — use sparingly.
 */
export async function isSuperAdmin(): Promise<boolean> {
  const supabase = await createServer();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) {
    if (!isSessionMissing(authError)) console.error('[auth] super-admin user lookup failed', authError);
    return false;
  }
  if (!auth.user) return false;
  // Code/env allowlist first — works even if the super_admins migration (0008)
  // hasn't been applied to this database yet.
  if (isSuperAdminEmail(auth.user.email)) return true;
  const { data, error } = await supabase.rpc('is_super_admin');
  if (error) console.error('[auth] super-admin allowlist lookup failed', error);
  return data === true;
}

/**
 * The plan level to gate FEATURE CONTENT by, with super-admins bumped to the max
 * (2 = Family+). Use this anywhere a page/route/action would otherwise gate on the
 * raw `planLevel(subscription)` so site super-admins get everything 100% unlocked
 * — mirroring `requireFeature` / `requirePlanLevel`, which already bypass for them.
 * Do NOT use in system/cron contexts that process families by their real plan.
 */
export async function effectivePlanLevel(rawLevel: number): Promise<number> {
  return (await isSuperAdmin()) ? 2 : rawLevel;
}

/**
 * Resolves the full user + active-family context. Returns null when not signed in,
 * or { needsFamily: true } when signed in but not yet in any family.
 */
export async function getUserContext(): Promise<UserContext | { needsFamily: true } | null> {
  const supabase = await createServer();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  // An absent session is the ordinary signed-out state, not a failure. Throwing
  // on it replaced the login redirect with a full-page error card on every
  // authenticated route — the caller (`requireUserContext`) sends a null
  // context to /login, which is what an expired cookie should do.
  if (authError && !isSessionMissing(authError)) throwContextUnavailable('authenticated user', authError);
  if (!auth.user) return null;

  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select('*')
    .eq('user_id', auth.user.id)
    .eq('is_active', true);
  if (membersError) throwContextUnavailable('family membership', membersError);

  const rows = members ?? [];
  if (rows.length === 0) return { needsFamily: true };

  const familyIds = rows.map((m) => m.family_id);
  const { data: families, error: familiesError } = await supabase.from('families').select('*').in('id', familyIds);
  if (familiesError) throwContextUnavailable('family', familiesError);
  const byId = new Map((families ?? []).map((f) => [f.id, f]));

  // A membership without its family row is not an onboarding state. Treating
  // it as one could auto-provision a second family during a partial read or RLS
  // regression, obscuring the original tenant-context failure.
  if (familyIds.some((familyId) => !byId.has(familyId))) {
    console.error('[auth] family context incomplete', {
      expected: familyIds.length,
      received: byId.size,
    });
    throw new Error('Account context is temporarily unavailable.');
  }

  const memberships: FamilyMembership[] = rows
    .map((m) => {
      const family = byId.get(m.family_id);
      return family
        ? { familyId: m.family_id, family, role: m.role as MemberRole, member: m }
        : null;
    })
    .filter((m): m is FamilyMembership => m !== null);

  if (memberships.length !== rows.length) {
    console.error('[auth] family membership context incomplete', {
      expected: rows.length,
      received: memberships.length,
    });
    throw new Error('Account context is temporarily unavailable.');
  }
  if (memberships.length === 0) return { needsFamily: true };

  // Preferences only choose WHICH family is active among the ones already
  // resolved above. A failed read there is not missing tenant context, so it
  // must not be fatal: treating it as one took every authenticated page down
  // over a stored preference. Fall back to the first membership — the right
  // answer outright for the single-family majority — and log the failure.
  const { data: prefs, error: prefsError } = await supabase
    .from('user_preferences')
    .select('active_family_id')
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (prefsError) console.error('[auth] user preference query failed; using the first membership', prefsError);

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
  if ('needsFamily' in ctx) {
    // Never trap a signed-in user in an onboarding loop. Auto-provision their
    // family space, then re-resolve — so signing up lands you straight on the
    // dashboard (with an "Invite your family" card), not a mandatory wizard.
    const supabase = await createServer();
    const { data: auth } = await supabase.auth.getUser();
    if (auth.user) {
      const ok = await ensureActiveFamily(supabase, auth.user);
      if (ok) {
        const next = await getUserContext();
        if (next && !('needsFamily' in next)) return next;
      }
    }
    // Fallback only if provisioning genuinely failed (e.g. DB unreachable):
    // the manual wizard. requireUserContext is NOT called there, so no loop.
    redirect('/onboarding');
  }
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
  const level = await resolveFamilyPlanLevel(supabase, ctx.active.familyId);
  if (level < minLevel) {
    redirect(`/dashboard/billing?upgrade=1&need=${minLevel}`);
  }
  return ctx;
}

/**
 * Feature-aware page guard. Resolves the feature's effective tier from the
 * admin's Tier & Features settings (override → code default), then enforces it:
 *   off  → notFound() (super-admins still pass, to preview)
 *   else → redirect to billing when the family's plan is below the tier's level.
 * `key` is the feature's route, e.g. '/dashboard/chores'.
 */
export async function requireFeature(key: string): Promise<UserContext> {
  const ctx = await requireUserContext();

  // Super administrators bypass tier gating entirely (including Off).
  if (await isSuperAdmin()) return ctx;

  const supabase = await createServer();
  const [level, byHref] = await Promise.all([
    resolveFamilyPlanLevel(supabase, ctx.active.familyId),
    getFeatureTiersByHref(supabase),
  ]);

  const tier = byHref[key];
  if (tier === undefined) return ctx;   // route not in the catalog → not gated
  if (tier === 'off') notFound();

  const need = tierToLevel(tier); // 0 / 1 / 2
  if (level < need) {
    redirect(`/dashboard/billing?upgrade=1&need=${need}`);
  }
  return ctx;
}
