// lib/features/catalog.ts — the single source of truth for tier-gated features.
//
// A "feature" is a gateable destination (a nav route). Each has a DEFAULT tier
// derived from the nav config; a super-admin can override it from
// /admin/tiers (persisted to public.feature_settings). The tier → access
// semantics are exactly:
//   free  → Free, Basic, Plus       (visible to all)
//   basic → Basic, Plus             (LOCKED for Free)
//   plus  → Plus only               (LOCKED for Basic + Free)
//   off   → nobody                  (hidden / blocked; super-admins still preview)
//
// Pure + dependency-light so it's usable in client (nav), server (route guard),
// and unit tests alike.
import { APP_NAV_GROUPS, MOBILE_TABS } from '@/lib/constants/navigation';

export type FeatureTier = 'free' | 'basic' | 'plus' | 'off';
export const FEATURE_TIERS: FeatureTier[] = ['free', 'basic', 'plus', 'off'];

export const TIER_LABELS: Record<FeatureTier, string> = {
  free: 'Free', basic: 'Basic', plus: 'Plus', off: 'Off',
};

/** Map a feature tier to the minimum plan level that can use it (off = blocked). */
export function tierLevel(tier: FeatureTier): number {
  switch (tier) {
    case 'free': return 0;
    case 'basic': return 1;
    case 'plus': return 2;
    case 'off': return Number.POSITIVE_INFINITY;
  }
}

/** Inverse: a numeric plan/min level (0/1/2) → its tier. */
export function levelTier(level: number | null | undefined): FeatureTier {
  if (level === 2) return 'plus';
  if (level === 1) return 'basic';
  return 'free';
}

export type FeatureAccess = 'visible' | 'locked' | 'hidden';

/**
 * Resolve what a user at `userLevel` (0/1/2) sees for a feature at `tier`.
 * Super-admins always see everything (so they can preview Off features).
 */
export function featureAccess(tier: FeatureTier, userLevel: number, isSuperAdmin = false): FeatureAccess {
  if (isSuperAdmin) return 'visible';
  if (tier === 'off') return 'hidden';
  return userLevel >= tierLevel(tier) ? 'visible' : 'locked';
}

export type FeatureOverrides = Record<string, FeatureTier>;

/** Effective tier for a feature: admin override (if any) else the code default. */
export function effectiveTier(key: string, overrides: FeatureOverrides | null | undefined): FeatureTier {
  const ov = overrides?.[key];
  if (ov && (FEATURE_TIERS as string[]).includes(ov)) return ov;
  return DEFAULT_TIER.get(key) ?? 'free';
}

export type FeatureDef = { key: string; label: string; group: string; defaultTier: FeatureTier };

// Build the catalog from the nav: every nav item with a clean route (no '#'
// fragment, no duplicates) is a gateable feature. Its default tier = its
// nav minLevel.
function buildCatalog(): FeatureDef[] {
  const out: FeatureDef[] = [];
  const seen = new Set<string>();
  for (const group of APP_NAV_GROUPS) {
    for (const item of group.items) {
      const key = item.href;
      if (key.includes('#') || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, label: item.label, group: group.title, defaultTier: levelTier(item.minLevel) });
    }
  }
  // MOBILE_TABS are a subset of the same routes; include any not already present.
  for (const item of MOBILE_TABS) {
    if (item.href.includes('#') || seen.has(item.href)) continue;
    seen.add(item.href);
    out.push({ key: item.href, label: item.label, group: 'Mobile', defaultTier: levelTier(item.minLevel) });
  }
  return out;
}

export const FEATURES: FeatureDef[] = buildCatalog();
export const DEFAULT_TIER: Map<string, FeatureTier> = new Map(FEATURES.map((f) => [f.key, f.defaultTier]));

/** Is this route key a known, gateable feature? */
export function isFeatureKey(key: string): boolean {
  return DEFAULT_TIER.has(key);
}

/** Group the catalog for admin display, preserving nav group order. */
export function featuresByGroup(): { group: string; items: FeatureDef[] }[] {
  const order: string[] = [];
  const map = new Map<string, FeatureDef[]>();
  for (const f of FEATURES) {
    if (!map.has(f.group)) { map.set(f.group, []); order.push(f.group); }
    map.get(f.group)!.push(f);
  }
  return order.map((group) => ({ group, items: map.get(group)! }));
}
