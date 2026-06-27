// lib/dashboard/layout.ts — pure dashboard layout resolution + validation.
// Decides which customizable buttons a user sees (tier-filtered, deduped,
// gap-filled, locked removed) and validates layout writes server-side. Fully
// tested; no I/O. The fixed "+" and AI buttons are handled by the UI, never here.
import {
  DASH_FEATURES, FEATURE_BY_KEY, DEFAULT_LAYOUT_BY_TIER, MAX_DASH_BUTTONS, TIER_RANK,
  type DashFeature, type DashTier,
} from '@/lib/dashboard/registry';

/** Is a feature available at (i.e. included in) the given plan tier? */
export function isAvailableAtTier(feature: DashFeature, tier: DashTier): boolean {
  return feature.isCustomizable && TIER_RANK[feature.requiredTier] <= TIER_RANK[tier];
}

/** All customizable features the tier unlocks, in registry order. */
export function availableFeatures(tier: DashTier): DashFeature[] {
  return DASH_FEATURES.filter((f) => isAvailableAtTier(f, tier));
}

/** Locked features (above the tier) for the upgrade-discovery area. */
export function lockedFeatures(tier: DashTier): DashFeature[] {
  return DASH_FEATURES.filter((f) => f.isCustomizable && TIER_RANK[f.requiredTier] > TIER_RANK[tier]);
}

/**
 * Resolve the primary customizable buttons to render:
 *  1) start from the saved keys (or the tier default when none),
 *  2) keep only existing, customizable, tier-available, de-duplicated keys
 *     (this silently drops locked features after a downgrade + broken keys),
 *  3) fill any remaining slots from the tier default, then the rest of the
 *     available set, up to MAX_DASH_BUTTONS.
 */
export function resolvePrimary(savedKeys: string[] | null | undefined, tier: DashTier): DashFeature[] {
  const availSet = new Set(availableFeatures(tier).map((f) => f.key));
  const seen = new Set<string>();
  const out: DashFeature[] = [];

  const take = (key: string) => {
    if (out.length >= MAX_DASH_BUTTONS) return;
    if (seen.has(key) || !availSet.has(key)) return;
    const f = FEATURE_BY_KEY[key];
    if (!f) return;
    seen.add(key);
    out.push(f);
  };

  const base = savedKeys && savedKeys.length > 0 ? savedKeys : DEFAULT_LAYOUT_BY_TIER[tier];
  for (const k of base) take(k);
  // gap-fill so the dashboard is never sparse / broken
  for (const k of DEFAULT_LAYOUT_BY_TIER[tier]) take(k);
  for (const f of availableFeatures(tier)) take(f.key);
  return out;
}

export type LayoutValidation = { ok: boolean; error?: string; keys: string[] };

/**
 * Server-side validation of a proposed customizable layout. Rejects unknown,
 * fixed, locked, or duplicate keys and over-long layouts. Returns the cleaned
 * key list (order preserved) when ok.
 */
export function validateLayout(keys: unknown, tier: DashTier): LayoutValidation {
  if (!Array.isArray(keys)) return { ok: false, error: 'Invalid layout.', keys: [] };
  if (keys.length > MAX_DASH_BUTTONS) return { ok: false, error: `A maximum of ${MAX_DASH_BUTTONS} buttons is allowed.`, keys: [] };

  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of keys) {
    if (typeof raw !== 'string') return { ok: false, error: 'Invalid feature.', keys: [] };
    const f = FEATURE_BY_KEY[raw];
    if (!f) return { ok: false, error: `Unknown feature: ${raw}`, keys: [] };
    if (f.isFixed || !f.isCustomizable) return { ok: false, error: `${f.label} can’t be customized.`, keys: [] };
    if (TIER_RANK[f.requiredTier] > TIER_RANK[tier]) return { ok: false, error: `${f.label} requires an upgrade.`, keys: [] };
    if (seen.has(raw)) return { ok: false, error: `Duplicate feature: ${f.label}`, keys: [] };
    seen.add(raw);
    clean.push(raw);
  }
  return { ok: true, keys: clean };
}

/** Keys available to ADD (tier-available, not already in the current layout). */
export function addableFeatures(currentKeys: string[], tier: DashTier): DashFeature[] {
  const have = new Set(currentKeys);
  return availableFeatures(tier).filter((f) => !have.has(f.key));
}
