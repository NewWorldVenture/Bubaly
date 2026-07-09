// lib/marketplace/buyer-search.ts — the AI Buyer Assistant's deterministic core
// (pure, unit-tested). The spec: a buyer asks in natural language ("find me a
// blue dress in size 6 to rent near me", "a stroller to borrow this weekend",
// "is this a fair price?") and gets ranked results with reasoning.
//
// This turns a free-text query into a structured MatchRequest (reusing the
// listing-draft hint extractor) and runs it through the matching engine, so the
// buyer assistant and the request→listing matcher share ONE ranking core. The
// LLM layer can paraphrase the reasons; this stands alone when AI is off.

import { parseListingHints } from './listing-draft';
import { matchRequest, type MatchListing, type MatchRequest, type MatchResult, type MatchMode } from './matching';

/** Extract a budget ceiling (cents) from phrases like "under $50", "below 40", "$25". */
export function parseBudgetCents(text: string): number | undefined {
  const t = text.toLowerCase();
  // Prefer an explicit ceiling ("under/below/less than/max $N"), else a bare "$N".
  const ceil = /(?:under|below|less than|max(?:imum)?|up to|no more than)\s*\$?\s*(\d+(?:\.\d{1,2})?)/.exec(t);
  const bare = /\$\s*(\d+(?:\.\d{1,2})?)/.exec(t);
  const num = ceil?.[1] ?? bare?.[1];
  if (!num) return undefined;
  const dollars = Number.parseFloat(num);
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : undefined;
}

/** The single buyer intent for a query: which way they want to acquire the item. */
export function parseBuyerMode(text: string): MatchMode {
  const t = ` ${text.toLowerCase()} `;
  if (/\b(rent|renting)\b/.test(t)) return 'rent';
  if (/\bborrow\b/.test(t)) return 'borrow';
  if (/\b(buy|purchase|for sale|sell)\b/.test(t)) return 'buy';
  return 'any';
}

/**
 * Parse a natural-language buyer query into a MatchRequest. Reuses the listing
 * hint extractor for category/color/size/brand/condition, then adds budget and a
 * single acquisition mode.
 */
export function parseBuyerQuery(text: string): MatchRequest {
  const hints = parseListingHints(text);
  return {
    title: text,
    itemType: hints.category,
    preferredMode: parseBuyerMode(text),
    size: hints.size,
    color: hints.color,
    brand: hints.brand,
    condition: hints.condition,
    budgetCents: parseBudgetCents(text),
  };
}

/**
 * The AI Buyer Assistant end to end: parse the query, then rank the candidate
 * listings with the shared matching engine. Returns ranked MatchResults (score +
 * reasons) — empty when nothing qualifies.
 */
export function searchListings(
  text: string,
  listings: MatchListing[],
  opts?: { limit?: number; minScore?: number },
): MatchResult[] {
  return matchRequest(parseBuyerQuery(text), listings, opts);
}
