// lib/marketplace/quick-post.ts — "Post in under 60 seconds with AI" (pure, tested).
//
// Backlog #10: posting to the family marketplace should be one sentence, not a
// form. The seller types/says ONE line — "Selling Emma's barely-used balance
// bike, $40, pickup in the garage" — and the drafting engine extracts the
// listing: kind (sell/free/wanted/rent/borrow/swap/donate), category, condition,
// price, pickup spot, a cleaned title and a polished description. A price
// suggestion is computed from the family's own comparable listings. All
// deterministic (no model key, instant, offline-safe); an LLM can enrich the
// description later without changing this contract.

import type { ListingCategory, ListingCondition, ListingKind } from './listings';

export interface QuickDraft {
  title: string;
  kind: ListingKind;
  category: ListingCategory;
  condition: ListingCondition | null;
  priceCents: number | null;      // stated in the input; null = not stated
  location: string | null;
  description: string;
  /** Which fields the engine actually detected (drives the "AI filled" chips). */
  matched: ('kind' | 'category' | 'condition' | 'price' | 'location')[];
}

// ── Extraction ───────────────────────────────────────────────────────────────

const KIND_SIGNALS: [ListingKind, RegExp][] = [
  ['wanted', /\b(looking for|in search of|\biso\b|wanted|anyone (have|got)|does anyone)\b/i],
  ['free', /\b(free to a good home|giving away|giveaway|for free|no charge)\b/i],
  ['rent', /\b(for rent|rent(ing)? out|available to rent)\b/i],
  ['borrow', /\b(borrow|happy to lend|can lend|loan out)\b/i],
  ['swap', /\b(swap|trade)\b/i],
  ['donate', /\b(donat(e|ing))\b/i],
];

const CONDITION_SIGNALS: [ListingCondition, RegExp][] = [
  ['new', /\b(brand new|new in box|new with tags|never (been )?used|unopened)\b/i],
  ['like_new', /\b(like[- ]new|barely[- ]used|mint( condition)?|excellent condition|hardly[- ]used)\b/i],
  ['good', /\b(good condition|gently[- ]used|lightly[- ]used|works great)\b/i],
  ['worn', /\b(well[- ]loved|worn|beat[- ]up|rough shape|heavily used)\b/i],
  ['fair', /\b(fair( condition)?|some wear|well[- ]used|a few scratches)\b/i],
];

const CATEGORY_SIGNALS: [ListingCategory, RegExp][] = [
  ['baby', /\b(stroller|crib|bassinet|high ?chair|baby|infant|onesie|diaper|car seat)\b/i],
  ['toys', /\b(lego|toy|doll|balance bike|trike|play ?set|puzzle|action figure|plush|blocks)\b/i],
  ['games', /\b(board game|video game|nintendo|xbox|playstation|switch|game)\b/i],
  ['books', /\b(book|novel|textbook|series|hardcover|paperback)\b/i],
  ['electronics', /\b(ipad|tablet|laptop|phone|monitor|headphones|speaker|camera|kindle|console)\b/i],
  ['furniture', /\b(desk|couch|sofa|table|chair|bookshelf|shelf|dresser|bed ?frame|nightstand|lamp)\b/i],
  ['sports', /\b(bike|bicycle|scooter|cleats|racket|racquet|skis|skates|helmet|soccer|basketball|baseball|tennis|golf)\b/i],
  ['tools', /\b(drill|saw|ladder|mower|toolbox|wrench|sander|pressure washer|hedge trimmer)\b/i],
  ['clothing', /\b(coat|jacket|shoes|boots|dress|jeans|shirt|sweater|snow ?pants|costume|uniform|clothes|clothing)\b/i],
];

const LOCATION_RX = /\b(?:pickup|pick up|it'?s)?\s*(?:in|on|at|from)\s+the\s+(garage|basement|attic|shed|porch|front porch|hall closet|playroom|barn)\b/i;

/** First stated dollar amount → cents. "$40", "$12.50", "40 bucks", "asking 40". */
export function extractPriceCents(text: string): number | null {
  const dollar = text.match(/\$\s?(\d{1,5}(?:\.\d{1,2})?)/);
  if (dollar) return Math.round(parseFloat(dollar[1]) * 100);
  const words = text.match(/\b(\d{1,5}(?:\.\d{1,2})?)\s?(?:dollars|bucks)\b/i);
  if (words) return Math.round(parseFloat(words[1]) * 100);
  const asking = text.match(/\basking\s+(\d{1,5}(?:\.\d{1,2})?)\b/i);
  if (asking) return Math.round(parseFloat(asking[1]) * 100);
  return null;
}

const STRIP_PHRASES: RegExp[] = [
  /^\s*(selling|for sale:?|sale:?|giving away|giveaway|donating|looking for|in search of|iso:?|wanted:?|for rent:?|renting( out)?|happy to lend|can lend)\s*[:,-]?\s*/i,
  /\$\s?\d{1,5}(?:\.\d{1,2})?\s*(obo|firm)?/gi,
  /\b\d{1,5}(?:\.\d{1,2})?\s?(?:dollars|bucks)\b(\s*obo)?/gi,
  /\basking\s+\d{1,5}(?:\.\d{1,2})?\b/gi,
  /\b(brand new|new in box|new with tags|never (been )?used|unopened|like[- ]new|barely[- ]used|mint( condition)?|excellent condition|hardly[- ]used|good condition|gently[- ]used|lightly[- ]used|works great|well[- ]loved|worn|beat[- ]up|rough shape|heavily used|fair condition|some wear|well[- ]used|a few scratches)\b/gi,
  /\b(?:pickup|pick up)?\s*(?:in|on|at|from)\s+the\s+(?:garage|basement|attic|shed|porch|front porch|hall closet|playroom|barn)\b/gi,
  /\b(free to a good home|for free|no charge|obo)\b/gi,
];

/** Clean the input into a listing title: strip intent/price/condition phrases. */
function deriveTitle(input: string): string {
  let t = ` ${input.trim()} `;
  for (const rx of STRIP_PHRASES) t = t.replace(rx, ' ');
  t = t.replace(/\s{2,}/g, ' ').replace(/^[\s,.\-–—:;]+|[\s,.\-–—:;]+$/g, '').trim();
  if (!t) t = input.trim().slice(0, 70);
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > 70 ? `${t.slice(0, 67).trimEnd()}…` : t;
}

const KIND_LINE: Record<ListingKind, string> = {
  sell: 'Priced to move — first come, first served.',
  rent: 'Available to rent — message to sort out timing.',
  borrow: 'Happy to lend it out — just bring it back in one piece.',
  free: 'Free to a good home — just come grab it.',
  wanted: 'If your family has one gathering dust, we would love it.',
  swap: 'Open to a swap — tell us what you have.',
  donate: 'Donating — hoping it helps another family.',
};

const CONDITION_LINE: Record<ListingCondition, string> = {
  new: 'Brand new and never used.',
  like_new: 'Barely used and in like-new shape.',
  good: 'Gently used and in good condition.',
  fair: 'Used with some wear, priced accordingly.',
  worn: 'Well loved — plenty of life left for the price.',
};

/** Draft a complete, editable listing from one freeform line. */
export function draftListing(input: string): QuickDraft {
  const text = input.trim();
  const matched: QuickDraft['matched'] = [];

  let kind: ListingKind = 'sell';
  for (const [k, rx] of KIND_SIGNALS) {
    if (rx.test(text)) { kind = k; matched.push('kind'); break; }
  }

  let category: ListingCategory = 'other';
  for (const [c, rx] of CATEGORY_SIGNALS) {
    if (rx.test(text)) { category = c; matched.push('category'); break; }
  }

  let condition: ListingCondition | null = null;
  for (const [c, rx] of CONDITION_SIGNALS) {
    if (rx.test(text)) { condition = c; matched.push('condition'); break; }
  }

  const priceCents = extractPriceCents(text);
  if (priceCents != null) matched.push('price');

  const loc = text.match(LOCATION_RX);
  const location = loc ? `In the ${loc[1].toLowerCase()}` : null;
  if (location) matched.push('location');

  const title = deriveTitle(text);
  const description = [
    condition ? CONDITION_LINE[condition] : null,
    KIND_LINE[kind],
    location ? `Pickup: ${location.toLowerCase()}.` : null,
  ].filter(Boolean).join(' ');

  return { title, kind, category, condition, priceCents, location, description, matched };
}

// ── Price suggestion from the family's own comparables ──────────────────────

export interface Comparable {
  category: string;
  condition: string | null;
  price_cents: number | null;
  kind: string;
}

// Multipliers relative to a 'good'-condition baseline.
const CONDITION_FACTOR: Record<ListingCondition, number> = {
  new: 1.25, like_new: 1.1, good: 1.0, fair: 0.8, worn: 0.6,
};

/**
 * Suggest a price from comparable priced sell listings in the same category:
 * the median comp (normalized to 'good' condition), re-adjusted to the item's
 * condition and rounded to the nearest dollar. Needs ≥2 comps, else null.
 */
export function suggestPriceCents(
  category: ListingCategory,
  condition: ListingCondition | null,
  comps: Comparable[],
): number | null {
  const usable = comps
    .filter((c) => c.category === category && c.kind === 'sell' && (c.price_cents ?? 0) > 0)
    .map((c) => {
      const f = CONDITION_FACTOR[(c.condition ?? 'good') as ListingCondition] ?? 1.0;
      return (c.price_cents as number) / f; // normalize to 'good' baseline
    })
    .sort((a, b) => a - b);
  if (usable.length < 2) return null;

  const mid = Math.floor(usable.length / 2);
  const median = usable.length % 2 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;
  const adjusted = median * (CONDITION_FACTOR[condition ?? 'good'] ?? 1.0);
  return Math.max(100, Math.round(adjusted / 100) * 100);
}
