import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
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
  | { allowed: false; reason: 'plan'; needLevel: number; planLevel: number };

/**
 * `href` is the feature's route key, e.g. '/dashboard/autopilot'.
 *
 * An href that is not in the feature catalog is NOT gated — it resolves to
 * allowed, matching `requireFeature`'s long-standing behaviour for routes that
 * predate the catalog.
 *
 * THROWS when the family's plan cannot be read. That is deliberate and is the
 * single most important thing about this function: an unreadable plan is not an
 * unentitled family, and returning `allowed: false` would turn a transient
 * database failure into a silent, wrong denial. Callers must decide what an
 * unknown answer means for them — a cron counts it as a failure for that family
 * and moves on, a request answers 503.
 *
 * Pass `tiers` when checking many families in one pass (a cron loop), so the
 * `app_settings` read happens once rather than per family.
 */
export async function resolveFeatureEntitlement(
  db: DB,
  familyId: string,
  href: string,
  tiers?: Record<string, FeatureTier>,
): Promise<FeatureEntitlement> {
  const [planLevel, byHref] = await Promise.all([
    resolveFamilyPlanLevel(db, familyId),
    tiers ? Promise.resolve(tiers) : getFeatureTiersByHref(db),
  ]);

  const tier = byHref[href];
  if (tier === undefined) return { allowed: true, planLevel };
  if (tier === 'off') return { allowed: false, reason: 'off', needLevel: 0, planLevel };

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

/** The tier map, read once, for a caller that loops over families. */
export { getFeatureTiersByHref };
