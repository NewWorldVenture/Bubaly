// Marketplace price coach — pure engine, no I/O.
//
// Answers "is this a fair price?" from real comparable listings: builds a
// condition-normalized price band (25th / median / 75th percentile) for a
// category and classifies a given price against it. The page supplies the
// comps; this is deterministic and fully tested. (Sibling to quick-post's
// single-point suggestPriceCents — this returns the whole band + a verdict.)

export interface Comp {
  category: string;
  condition: string | null;
  priceCents: number | null;
  kind: string;
}

export interface PriceBand {
  lowCents: number;      // ~25th percentile, adjusted to the target condition
  medianCents: number;
  highCents: number;     // ~75th percentile
  sampleSize: number;
}

export type Deal = 'great_deal' | 'good_deal' | 'fair' | 'above_market' | 'unknown';

// Condition multipliers relative to a 'good' baseline (mirrors quick-post).
const CONDITION_FACTOR: Record<string, number> = {
  new: 1.25, like_new: 1.1, good: 1.0, fair: 0.8, worn: 0.6,
};
const factor = (c: string | null | undefined) => CONDITION_FACTOR[c ?? 'good'] ?? 1.0;

/** Linear-interpolation percentile over a sorted ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Build a price band from comparable priced 'sell' listings in the same
 * category, normalized to 'good' condition and then re-adjusted to the target
 * condition. Needs ≥3 comps (else null — not enough signal to advise).
 */
export function priceBand(
  category: string,
  condition: string | null,
  comps: Comp[],
  minSample = 3,
): PriceBand | null {
  const norm = comps
    .filter((c) => c.category === category && c.kind === 'sell' && (c.priceCents ?? 0) > 0)
    .map((c) => (c.priceCents as number) / factor(c.condition))
    .sort((a, b) => a - b);
  if (norm.length < minSample) return null;

  const f = factor(condition);
  const round = (v: number) => Math.max(100, Math.round((v * f) / 100) * 100);
  return {
    lowCents: round(percentile(norm, 0.25)),
    medianCents: round(percentile(norm, 0.5)),
    highCents: round(percentile(norm, 0.75)),
    sampleSize: norm.length,
  };
}

/** Classify a price against a band. */
export function assessPrice(priceCents: number, band: PriceBand | null): Deal {
  if (!band || priceCents <= 0) return 'unknown';
  if (priceCents <= band.lowCents) return 'great_deal';
  if (priceCents <= band.medianCents) return 'good_deal';
  if (priceCents <= band.highCents) return 'fair';
  return 'above_market';
}

export function dealLabel(deal: Deal): { text: string; tone: 'ok' | 'good' | 'muted' | 'warn' } | null {
  switch (deal) {
    case 'great_deal':   return { text: 'Great price', tone: 'ok' };
    case 'good_deal':    return { text: 'Good price', tone: 'good' };
    case 'fair':         return { text: 'Fair price', tone: 'muted' };
    case 'above_market': return { text: 'Above similar items', tone: 'warn' };
    default:             return null;
  }
}

const money = (c: number) => `$${Math.round(c / 100)}`;

/** "Similar items: $20–$45" — the range shown under the verdict. */
export function bandSummary(band: PriceBand | null): string | null {
  if (!band) return null;
  return `Similar items: ${money(band.lowCents)}–${money(band.highCents)}`;
}
