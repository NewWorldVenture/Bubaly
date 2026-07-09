// lib/marketplace/matches.ts — Marketplace match intelligence (pure, tested).
//
// The next level for the family marketplace: it already lets a member post a
// "wanted" request AND lets others list items to sell / give away / lend / rent —
// but nothing connects the two. This engine closes the loop: for every open
// "wanted" it finds the supply already on the board that would satisfy it ("Dad
// wants a drill — Mom listed one to borrow"), scored + explained, so the board
// becomes proactive instead of a passive bulletin. Framework-free + DB-free; the
// server feeds it real rows and persists the results.

export type MatchListing = {
  id: string;
  kind: string;      // sell | rent | borrow | free | wanted
  category: string;
  status: string;
  title: string;
  member_id: string | null;
  price_cents: number;
};

export type MarketplaceMatch = {
  wantedId: string;
  supplyId: string;
  supplyKind: string;
  score: number;            // 0..100
  sameCategory: boolean;
  sharedTerms: string[];
  supplyFree: boolean;
};

const SUPPLY_KINDS = new Set(['sell', 'rent', 'borrow', 'free']);
const OPEN_STATUS = new Set(['available', 'pending']);

// Small, deliberately generic stopword list so "a bike" and "the Bike!" match.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'my', 'our',
  'your', 'kids', 'kid', 'set', 'new', 'used', 'looking', 'want', 'wanted', 'need',
  'size', 'pair', 'one', 'some', 'any',
]);

/** Lowercased, de-duped meaningful terms from a title (≥3 chars, non-stopword). */
export function titleTerms(title: string): string[] {
  const seen = new Set<string>();
  for (const raw of title.toLowerCase().split(/[^a-z0-9]+/)) {
    const t = raw.trim();
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    seen.add(t);
  }
  return [...seen];
}

/** Terms shared by two titles (the overlap that makes a match legible). */
export function sharedTerms(a: string, b: string): string[] {
  const bset = new Set(titleTerms(b));
  return titleTerms(a).filter((t) => bset.has(t));
}

/**
 * Score one wanted↔supply pair 0..100, or null if it isn't a real match.
 * A match needs the SAME category or ≥1 shared title term (both = strongest).
 * Weighting: category 45, each shared term 22 (cap 2), free bonus 12, base 10.
 */
export function scoreMatch(wanted: MatchListing, supply: MatchListing): MarketplaceMatch | null {
  const sameCategory = wanted.category === supply.category && wanted.category !== 'other';
  const terms = sharedTerms(wanted.title, supply.title);
  if (!sameCategory && terms.length === 0) return null;

  const supplyFree = supply.kind === 'free';
  let score = 10;
  if (sameCategory) score += 45;
  score += Math.min(2, terms.length) * 22;
  if (supplyFree) score += 12;
  score = Math.min(100, score);

  return { wantedId: wanted.id, supplyId: supply.id, supplyKind: supply.kind, score, sameCategory, sharedTerms: terms, supplyFree };
}

/**
 * Compute the best supply matches for every open "wanted" on the board.
 * Supply must be open, a real supply kind, and posted by a DIFFERENT member than
 * the wanter (you can't fulfill your own request). Returns matches sorted by score
 * desc, capped to `perWanted` per request so one popular ask can't flood the strip.
 */
export function computeMatches(listings: MatchListing[], perWanted = 3): MarketplaceMatch[] {
  const wanted = listings.filter((l) => l.kind === 'wanted' && OPEN_STATUS.has(l.status));
  const supply = listings.filter((l) => SUPPLY_KINDS.has(l.kind) && OPEN_STATUS.has(l.status));
  if (wanted.length === 0 || supply.length === 0) return [];

  const out: MarketplaceMatch[] = [];
  for (const w of wanted) {
    const forThis: MarketplaceMatch[] = [];
    for (const s of supply) {
      // Distinct members only when both are known; unknown members still match.
      if (w.member_id && s.member_id && w.member_id === s.member_id) continue;
      const m = scoreMatch(w, s);
      if (m) forThis.push(m);
    }
    forThis.sort((a, b) => b.score - a.score || a.supplyId.localeCompare(b.supplyId));
    out.push(...forThis.slice(0, perWanted));
  }
  return out.sort((a, b) => b.score - a.score || a.wantedId.localeCompare(b.wantedId));
}
