// lib/features/tiers.ts — pure tier resolution. Merges admin overrides over the
// catalog defaults and answers "is this feature available at plan level N?".
// No Supabase/React — deterministic + unit-tested.

import { FEATURE_CATALOG, type FeatureTier, type FeatureDef } from '@/lib/constants/feature-catalog';

export const TIER_ORDER: FeatureTier[] = ['off', 'free', 'basic', 'plus'];
export const TIER_LABELS: Record<FeatureTier, string> = {
  off: 'Off', free: 'Free Tier', basic: 'Basic Tier', plus: 'Plus Tier',
};

/** Plan level a tier maps to: free=0, basic=1, plus=2. 'off' = unavailable (-1). */
export function tierToLevel(tier: FeatureTier): number {
  switch (tier) {
    case 'free': return 0;
    case 'basic': return 1;
    case 'plus': return 2;
    default: return -1; // off
  }
}

export function isFeatureTier(v: string): v is FeatureTier {
  return (TIER_ORDER as string[]).includes(v);
}

export type FeatureOverrides = Record<string, FeatureTier>;

/**
 * The effective tier for every catalog feature = override (if valid + the key
 * exists in the catalog) else the catalog default. Unknown override keys are
 * ignored so a stale config never invents features.
 */
export function resolveFeatureTiers(overrides: FeatureOverrides | null | undefined): Record<string, FeatureTier> {
  const out: Record<string, FeatureTier> = {};
  for (const f of FEATURE_CATALOG) {
    const o = overrides?.[f.key];
    out[f.key] = o && isFeatureTier(o) ? o : f.defaultTier;
  }
  return out;
}

/**
 * Is a feature (by its resolved tier) available to a family on `planLevel`?
 * 'off' is never available; otherwise available when planLevel ≥ the tier's level.
 */
export function isFeatureAvailable(featureTier: FeatureTier, planLevel: number): boolean {
  const lvl = tierToLevel(featureTier);
  return lvl >= 0 && planLevel >= lvl;
}

/** Catalog features included in a given tier's plan (tier level ≤ that plan). */
export function featuresIncludedInPlan(
  resolved: Record<string, FeatureTier>,
  planTier: Exclude<FeatureTier, 'off'>,
): FeatureDef[] {
  const planLevel = tierToLevel(planTier);
  return FEATURE_CATALOG.filter((f) => isFeatureAvailable(resolved[f.key] ?? f.defaultTier, planLevel));
}

/** Features whose resolved tier is EXACTLY this tier (what's "new" at that tier). */
export function featuresAtTier(
  resolved: Record<string, FeatureTier>,
  tier: FeatureTier,
): FeatureDef[] {
  return FEATURE_CATALOG.filter((f) => (resolved[f.key] ?? f.defaultTier) === tier);
}

/** Minimal diff: only the keys whose tier differs from the catalog default. */
export function overridesFromResolved(resolved: Record<string, FeatureTier>): FeatureOverrides {
  const diff: FeatureOverrides = {};
  for (const f of FEATURE_CATALOG) {
    const r = resolved[f.key];
    if (r && r !== f.defaultTier) diff[f.key] = r;
  }
  return diff;
}
