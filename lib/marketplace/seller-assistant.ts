// lib/marketplace/seller-assistant.ts — the AI Seller Assistant + fair-price core
// (pure, unit-tested). Covers two spec features from one place:
//   • Seller: "improve listing quality, detect missing details, recommend rental
//     vs sale, demand-based pricing" → quality tips + a completeness score.
//   • Buyer:  "is this a fair price?" → a verdict vs comparable listings.
// Deterministic and framework-free; the LLM layer can paraphrase, and this stands
// alone when AI is off.

import { formatCents } from './listings';

// ── Fair-price / demand-based pricing ──────────────────────────────────────

export interface PriceComparable {
  priceCents: number;
  category?: string | null;
  condition?: string | null;
}

export type PriceStance = 'no_data' | 'great_deal' | 'fair' | 'above_market' | 'overpriced';

export interface PriceVerdict {
  medianCents: number | null;
  sampleSize: number;
  stance: PriceStance;
  suggestedCents: number | null;
  message: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Judge a price against comparable listings (same category, and same condition
 * when enough of them exist). Returns the comparable median, a stance, and a
 * suggested price — powering both the buyer's "is this fair?" and the seller's
 * demand-based pricing hint.
 */
export function priceVerdict(
  targetCents: number,
  comparables: PriceComparable[],
  filter: { category?: string | null; condition?: string | null } = {},
): PriceVerdict {
  let pool = comparables.filter((c) => c.priceCents > 0 && (!filter.category || c.category === filter.category));
  // Narrow to same condition only if it keeps a usable sample.
  if (filter.condition) {
    const byCond = pool.filter((c) => c.condition === filter.condition);
    if (byCond.length >= 3) pool = byCond;
  }
  const med = median(pool.map((c) => c.priceCents));
  if (med == null) {
    return { medianCents: null, sampleSize: 0, stance: 'no_data', suggestedCents: null,
      message: 'Not enough comparable listings yet to judge the price.' };
  }
  const ratio = targetCents / med;
  const stance: PriceStance =
    ratio <= 0.75 ? 'great_deal' : ratio <= 1.1 ? 'fair' : ratio <= 1.35 ? 'above_market' : 'overpriced';
  const messages: Record<PriceStance, string> = {
    no_data: '',
    great_deal: `Great deal — ${formatCents(targetCents)} is well below the ${formatCents(med)} typical for similar items.`,
    fair: `Fair price — right around the ${formatCents(med)} typical for similar items.`,
    above_market: `A bit high — similar items typically go for about ${formatCents(med)}.`,
    overpriced: `Overpriced — similar items typically go for about ${formatCents(med)}.`,
  };
  return { medianCents: med, sampleSize: pool.length, stance, suggestedCents: med, message: messages[stance] };
}

// ── Listing quality tips + completeness score ──────────────────────────────

export interface QualityListing {
  title?: string | null;
  description?: string | null;
  category?: string | null;
  condition?: string | null;
  photoUrl?: string | null;
  priceCents?: number | null;
  kind?: string | null;         // legacy: sell/rent/borrow/free/wanted
  location?: string | null;
}

export interface QualityTip {
  key: string;
  severity: 'high' | 'medium' | 'low';
  message: string;
}

const isSale = (kind?: string | null): boolean => kind === 'sell' || kind === 'rent';

/**
 * Concrete, ranked suggestions to improve a listing — the "detect missing
 * details / improve quality" seller feature. Ordered high → low severity.
 */
export function listingQualityTips(l: QualityListing): QualityTip[] {
  const tips: QualityTip[] = [];
  if (!l.photoUrl) tips.push({ key: 'photo', severity: 'high', message: 'Add a photo — listings with photos get far more interest.' });
  if (!l.title || l.title.trim().length < 3) tips.push({ key: 'title', severity: 'high', message: 'Add a clear title so people know what it is.' });
  if (isSale(l.kind) && !(l.priceCents && l.priceCents > 0)) tips.push({ key: 'price', severity: 'high', message: 'Set a price so buyers can act right away.' });
  if (!l.description || l.description.trim().length < 20) tips.push({ key: 'description', severity: 'medium', message: 'Add a few details (size, age, why you’re passing it on) to build trust.' });
  if (!l.category || l.category === 'other') tips.push({ key: 'category', severity: 'medium', message: 'Pick a specific category so the right people find it.' });
  if (!l.condition) tips.push({ key: 'condition', severity: 'low', message: 'Note the condition — buyers filter by it.' });
  if (!l.location) tips.push({ key: 'location', severity: 'low', message: 'Add a pickup area to attract nearby neighbors.' });
  // Rent-vs-sale nudge: a high-value sale item is often worth offering for rent too.
  if (l.kind === 'sell' && (l.priceCents ?? 0) >= 15_000) {
    tips.push({ key: 'rent_vs_sale', severity: 'low', message: 'This is valuable — consider offering it for rent to earn from it more than once.' });
  }
  const order = { high: 0, medium: 1, low: 2 };
  return tips.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** 0–100 listing completeness score (100 = nothing left to improve). */
export function qualityScore(l: QualityListing): number {
  const WEIGHTS: Record<string, number> = { photo: 30, title: 15, price: 20, description: 15, category: 10, condition: 5, location: 5 };
  const penalties = new Set(listingQualityTips(l).map((t) => t.key));
  let lost = 0;
  for (const [key, w] of Object.entries(WEIGHTS)) if (penalties.has(key)) lost += w;
  return Math.max(0, 100 - lost);
}
