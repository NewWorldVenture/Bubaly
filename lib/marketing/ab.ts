// Pure A/B-testing logic — deterministic assignment + two-proportion z-test.
// Unit tested, no dependencies.

export type ABVariant = { key: string; label: string };

/** True when an untrusted event payload names a variant configured by the experiment. */
export function hasConfiguredVariant(variants: unknown, key: string): boolean {
  if (!Array.isArray(variants) || !key) return false;
  return variants.some((variant) => {
    if (!variant || typeof variant !== 'object') return false;
    const candidate = (variant as { key?: unknown }).key;
    return typeof candidate === 'string' && candidate === key;
  });
}

/** Stable 32-bit FNV-1a hash → used for deterministic, sticky variant assignment. */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministically assign a visitor to one of the variants. Same
 * (experimentKey, visitorId) always yields the same variant (sticky), and the
 * split is even across variants.
 */
export function assignVariant(experimentKey: string, visitorId: string, variants: ABVariant[]): ABVariant | null {
  if (variants.length === 0) return null;
  const idx = hashString(`${experimentKey}:${visitorId}`) % variants.length;
  return variants[idx];
}

// Standard normal CDF via the Abramowitz & Stegun erf approximation.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export type VariantTotals = { key: string; label: string; exposures: number; conversions: number };

export type VariantResult = VariantTotals & {
  rate: number;          // conversion rate 0..1
  /** Relative lift vs. the control variant (first), or null for the control. */
  lift: number | null;
  /** Two-sided p-value vs. control (null for control / insufficient data). */
  pValue: number | null;
  significant: boolean;  // p < 0.05 with enough data
  isControl: boolean;
};

/**
 * Compute per-variant conversion rates and significance vs. the first (control)
 * variant using a two-proportion z-test.
 */
export function computeABResults(totals: VariantTotals[]): VariantResult[] {
  if (totals.length === 0) return [];
  const control = totals[0];
  const cRate = control.exposures > 0 ? control.conversions / control.exposures : 0;

  return totals.map((v, i) => {
    const rate = v.exposures > 0 ? v.conversions / v.exposures : 0;
    if (i === 0) {
      return { ...v, rate, lift: null, pValue: null, significant: false, isControl: true };
    }
    const lift = cRate > 0 ? (rate - cRate) / cRate : null;

    let pValue: number | null = null;
    let significant = false;
    if (control.exposures > 0 && v.exposures > 0) {
      const pPool = (control.conversions + v.conversions) / (control.exposures + v.exposures);
      const se = Math.sqrt(pPool * (1 - pPool) * (1 / control.exposures + 1 / v.exposures));
      if (se > 0) {
        const z = (rate - cRate) / se;
        pValue = 2 * (1 - normalCdf(Math.abs(z)));
        significant = pValue < 0.05;
      }
    }
    return { ...v, rate, lift, pValue, significant, isControl: false };
  });
}

/** The leading variant by rate once it's significant vs. control; else null. */
export function leadingVariant(results: VariantResult[]): VariantResult | null {
  const sig = results.filter((r) => !r.isControl && r.significant && r.rate > 0);
  if (sig.length === 0) return null;
  return sig.reduce((best, r) => (r.rate > best.rate ? r : best));
}
