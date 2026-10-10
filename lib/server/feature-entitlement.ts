import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { resolveFamilyEntitlement } from '@/lib/server/plan';
import { refusedStanding, type RefusedStanding } from '@/lib/server/entitlement';
import { getFeatureTiersByHref } from '@/lib/server/feature-tiers';
import { tierToLevel } from '@/lib/features/tiers';
import type { FeatureTier } from '@/lib/constants/feature-catalog';

type DB = SupabaseClient<Database>;

/**
 * Does one family have one feature, without redirecting?
 *
 * `requireFeature` answers the same question for a PAGE, and can only answer it
 * there: it resolves the caller's session and then throws a redirect. Anything
 * behind the page — a cron pass, a webhook, an API route — has no session to
 * resolve and nowhere to redirect to, so every such caller has so far either
 * re-implemented the check by hand (`lib/server/ai-access.ts`,
 * `lib/services/trips/confirmation-import.ts`,
 * `lib/services/onboarding-calendar/access.ts`) or skipped it.
 *
 * Skipping it is how Family Autopilot — a Plus feature — ran nightly for every
 * family on the platform, and how the family @bubaly.com address received mail
 * for families below Family+ (see `FAMILY_EMAIL_MIN_PLAN_LEVEL`). In both cases
 * the gate was real on the screen and absent in the pipeline behind it.
 *
 * So the resolution lives here and `requireFeature` is a wrapper over it. A page
 * and the pipeline serving it cannot now disagree about who is entitled,
 * because they compute it with the same function.
 */
export type FeatureEntitlement =
  | { allowed: true; planLevel: number }
  | { allowed: false; reason: 'off'; needLevel: number; planLevel: number }
  | { allowed: false; reason: 'plan'; needLevel: number; planLevel: number }
  | { allowed: false; reason: RefusedStanding; needLevel: number; planLevel: number };

/**
 * `href` is the feature's route key, e.g. '/dashboard/autopilot'.
 *
 * An href that is not in the feature catalog is not gated BY TIER — it resolves
 * to allowed, matching `requireFeature`'s long-standing behaviour for routes
 * that predate the catalog.
 *
 * A closed family, and one whose trial ended unpaid, are refused EVERY href,
 * Free-tier and uncatalogued ones included (`reason` 'closed' / 'trial_ended').
 * Both have plan level 0, the same as an open Free family, so comparing levels
 * alone handed them every Free-tier feature. Only 'off' is answered before
 * them, so a switched-off feature is never confirmed to exist.
 *
 * THROWS when the family's plan cannot be read. That is deliberate and is the
 * single most important thing about this function: an unreadable plan is not an
 * unentitled family, and returning `allowed: false` would turn a transient
 * database failure into a silent, wrong denial.
 *
 * It THROWS, too, when the feature tiers cannot be read (or not within their
 * budget). The opposite mistake is the one to avoid there: the catalog default
 * is not the configured tier — an admin can make a feature stricter than its
 * default — so falling back to it would let a failed lookup grant a paid
 * feature.
 *
 * Callers must decide what an unknown answer means for them — a cron counts it
 * as a failure for that family and moves on, a request answers 503.
 *
 * Pass `tiers` when checking many families in one pass (a cron loop), so the
 * `app_settings` read happens once rather than per family.
 */
/**
 * True when the family does NOT have the feature — which, on a page that
 * rendered at all, means a super admin is previewing it (requireFeature lets
 * them through; the feature's own API routes, rightly, do not).
 *
 * Such a page must not fire the feature's work on open: the call answers 403
 * and the preview opens on an error (page audit, 2026-09-27: /dashboard/
 * autopilot's scan and /dashboard/briefing's generate, each a 403 in the
 * console of every admin preview). A plan that cannot be read is NOT a
 * preview: the module goes ahead, and the route answers the read failure
 * itself.
 */
export async function isFeaturePreviewOnly(db: DB, familyId: string, href: string): Promise<boolean> {
  try {
    return !(await resolveFeatureEntitlement(db, familyId, href)).allowed;
  } catch (error) {
    console.error('[feature-entitlement] preview check could not read the plan', { familyId, href, error });
    return false;
  }
}

export async function resolveFeatureEntitlement(
  db: DB,
  familyId: string,
  href: string,
  tiers?: Record<string, FeatureTier>,
): Promise<FeatureEntitlement> {
  const [entitlement, byHref] = await Promise.all([
    resolveFamilyEntitlement(db, familyId),
    tiers ? Promise.resolve(tiers) : getFeatureTiersByHref(db, { onUnavailable: 'throw' }),
  ]);
  const planLevel = entitlement.effectiveLevel;

  const tier = byHref[href];
  if (tier === 'off') return { allowed: false, reason: 'off', needLevel: 0, planLevel };

  const standing = refusedStanding(entitlement);
  if (standing) {
    const tierLevel = tier === undefined ? 0 : tierToLevel(tier);
    // A trial-ended family needs at least Family Basic to unlock anything.
    return { allowed: false, reason: standing, needLevel: standing === 'trial_ended' ? Math.max(1, tierLevel) : tierLevel, planLevel };
  }

  if (tier === undefined) return { allowed: true, planLevel };

  const needLevel = tierToLevel(tier);
  if (planLevel < needLevel) return { allowed: false, reason: 'plan', needLevel, planLevel };
  return { allowed: true, planLevel };
}

/**
 * Boolean form, for a caller that treats 'off' and 'below the tier' the same
 * way. Still throws on an unreadable plan — see above.
 */
export async function familyHasFeature(
  db: DB,
  familyId: string,
  href: string,
  tiers?: Record<string, FeatureTier>,
): Promise<boolean> {
  return (await resolveFeatureEntitlement(db, familyId, href, tiers)).allowed;
}

/**
 * The tier map, read once, for a caller that loops over families. A caller
 * deciding access with it reads it with `{ onUnavailable: 'throw' }`.
 */
export { getFeatureTiersByHref };
