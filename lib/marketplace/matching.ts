// lib/marketplace/matching.ts — the request → listing matching engine (pure,
// unit-tested). Backs the spec's "AI should match requests to listings" and the
// marketplace_request_matches / marketplace_ai_matches tables: given a wanted
// request ("borrow a black cocktail dress, size M, this Friday"), rank the
// listings that could fulfil it with a 0–100 confidence score and human reasons.
//
// Deterministic and framework-free: the AI/server layer feeds it real rows and
// persists the top matches. Hard filters (availability, visibility, supported
// mode, budget, distance) disqualify a listing outright; soft dimensions
// (keywords, category, size/colour/brand/condition, price fit) are scored only
// when BOTH sides specify them, so a sparse request still matches sensibly.

export type MatchMode = 'buy' | 'rent' | 'borrow' | 'any';

export interface MatchRequest {
  title?: string | null;
  description?: string | null;
  itemType?: string | null;
  preferredMode?: MatchMode | null;
  size?: string | null;
  color?: string | null;
  brand?: string | null;
  condition?: string | null;
  budgetCents?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  radiusMiles?: number | null;
}

export interface MatchListing {
  id: string;
  title: string;
  description?: string | null;
  category?: string | null;
  subcategory?: string | null;
  /** Rich multi-mode list (0138). Falls back to the legacy single `kind`. */
  modes?: string[] | null;
  kind?: string | null;
  size?: string | null;
  color?: string | null;
  brand?: string | null;
  condition?: string | null;
  priceCents?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  status?: string | null;
  visibility?: string | null;
}

export interface MatchResult {
  listing: MatchListing;
  score: number;               // 0..100 confidence
  reasons: string[];
  distanceMiles: number | null;
}

export interface MatchOptions {
  /** Max results to return (after ranking). Default 20. */
  limit?: number;
  /** Drop matches below this score. Default 1 (anything with a signal). */
  minScore?: number;
}

// ── Weights for the soft dimensions (only counted when both sides specify) ──
const WEIGHTS = {
  keywords: 30,
  category: 15,
  brand: 12,
  size: 12,
  color: 10,
  condition: 8,
  budget: 8,
} as const;

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'my', 'me', 'i', 'need', 'want', 'looking', 'please', 'this', 'that']);

function tokens(...parts: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const p of parts) {
    if (!p) continue;
    for (const raw of p.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length >= 3 && !STOPWORDS.has(raw)) out.add(raw);
    }
  }
  return out;
}

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** The modes a listing effectively supports (rich `modes`, else mapped from `kind`). */
export function listingModes(listing: MatchListing): string[] {
  if (listing.modes && listing.modes.length) return listing.modes.map((m) => m.toLowerCase());
  switch (norm(listing.kind)) {
    case 'sell': return ['buy'];
    case 'rent': return ['rent'];
    case 'borrow': return ['borrow'];
    case 'free': return ['donate', 'borrow'];
    default: return [];
  }
}

/** Great-circle distance in miles between two lat/lng points, or null if unknown. */
export function distanceMiles(
  aLat?: number | null, aLng?: number | null, bLat?: number | null, bLng?: number | null,
): number | null {
  if (aLat == null || aLng == null || bLat == null || bLng == null) return null;
  const R = 3958.8; // Earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.asin(Math.min(1, Math.sqrt(s))) * 10) / 10;
}

/** A listing is eligible to match at all: browsable, publicly discoverable. */
function isEligible(listing: MatchListing): boolean {
  const status = norm(listing.status);
  const browsable = status === '' || status === 'available' || status === 'pending';
  const visible = !listing.visibility || norm(listing.visibility) === 'public';
  return browsable && visible;
}

/**
 * Score one listing against a request → { score 0..100, reasons } or null when a
 * HARD filter disqualifies it (ineligible, unsupported mode, over budget, or
 * outside the requested radius).
 */
export function scoreMatch(request: MatchRequest, listing: MatchListing): MatchResult | null {
  if (!isEligible(listing)) return null;

  const reasons: string[] = [];

  // ── Hard filter: supported mode ──
  const wantMode = request.preferredMode && request.preferredMode !== 'any' ? request.preferredMode : null;
  const modes = listingModes(listing);
  if (wantMode) {
    if (!modes.includes(wantMode)) return null;
    reasons.push(`available to ${wantMode}`);
  }

  // ── Hard filter: distance within radius (when both located) ──
  const dist = distanceMiles(request.latitude, request.longitude, listing.latitude, listing.longitude);
  if (dist != null && request.radiusMiles != null && dist > request.radiusMiles) return null;
  if (dist != null) reasons.push(`${dist} mi away`);

  // ── Hard filter: within budget (for paid modes only) ──
  const paid = wantMode === 'buy' || wantMode === 'rent' || (!wantMode && (modes.includes('buy') || modes.includes('rent')));
  if (paid && request.budgetCents != null && listing.priceCents != null && listing.priceCents > request.budgetCents) {
    return null;
  }

  // ── Soft dimensions: only scored when BOTH sides specify ──
  let earned = 0;
  let applicable = 0;
  const consider = (weight: number, applicableWhen: boolean, matched: boolean, reason: string) => {
    if (!applicableWhen) return;
    applicable += weight;
    if (matched) { earned += weight; reasons.push(reason); }
  };

  // Keywords: overlap of request tokens found in the listing's text.
  const reqTokens = tokens(request.title, request.itemType, request.description);
  const listTokens = tokens(listing.title, listing.description, listing.category, listing.subcategory, listing.brand);
  if (reqTokens.size > 0) {
    let hit = 0;
    for (const t of reqTokens) if (listTokens.has(t)) hit++;
    applicable += WEIGHTS.keywords;
    earned += WEIGHTS.keywords * (hit / reqTokens.size);
    if (hit > 0) reasons.push(`${hit}/${reqTokens.size} keywords match`);
  }

  consider(WEIGHTS.category, !!request.itemType && !!listing.category,
    norm(request.itemType).includes(norm(listing.category)) || norm(listing.category).includes(norm(request.itemType)),
    `category ${listing.category}`);
  consider(WEIGHTS.brand, !!request.brand && !!listing.brand, norm(request.brand) === norm(listing.brand), `brand ${listing.brand}`);
  consider(WEIGHTS.size, !!request.size && !!listing.size, norm(request.size) === norm(listing.size), `size ${listing.size}`);
  consider(WEIGHTS.color, !!request.color && !!listing.color, norm(request.color) === norm(listing.color), `${listing.color}`);
  consider(WEIGHTS.condition, !!request.condition && !!listing.condition, norm(request.condition) === norm(listing.condition), `condition ${listing.condition}`);
  consider(WEIGHTS.budget, paid && request.budgetCents != null && listing.priceCents != null, true, 'within budget');

  // No overlapping specified dimensions: a weak, mode/location-only match.
  const score = applicable > 0 ? Math.round((earned / applicable) * 100) : (reasons.length > 0 ? 40 : 0);
  return { listing, score, reasons, distanceMiles: dist };
}

/**
 * Rank all listings that could fulfil a request, best first. Disqualified
 * listings (hard filters) are dropped; ties break by distance (nearer first).
 */
export function matchRequest(request: MatchRequest, listings: MatchListing[], opts: MatchOptions = {}): MatchResult[] {
  const { limit = 20, minScore = 1 } = opts;
  const scored: MatchResult[] = [];
  for (const l of listings) {
    const r = scoreMatch(request, l);
    if (r && r.score >= minScore) scored.push(r);
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ad = a.distanceMiles ?? Infinity;
    const bd = b.distanceMiles ?? Infinity;
    if (ad !== bd) return ad - bd;
    return a.listing.id.localeCompare(b.listing.id);
  });
  return scored.slice(0, limit);
}
