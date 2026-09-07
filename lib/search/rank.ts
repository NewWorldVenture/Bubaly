// lib/search/rank.ts — how a household search result earns its place.
//
// The database decides WHICH rows match (an `ilike` fan-out today, a
// `search_household` trigram RPC once the owner approves that migration); this
// module decides which of them a person sees first, and it is pure so the
// answer is the same in the command bar, on /dashboard/search and in a test.
//
// Three signals, in the order they matter:
//   1. HOW the query matched — an exact title beats a prefix beats a word
//      prefix beats a substring. A body/snippet match counts for less than a
//      title match, because "the thing called that" is almost always what was
//      meant over "the thing that mentions it".
//   2. WHAT kind of record it is — a bill or a warranty is looked up to act on;
//      a note is browsed. The weights are small on purpose: they break ties,
//      they do not overturn a better match.
//   3. HOW CLOSE IN TIME it is — |now − date|, so next week's trip and last
//      week's receipt both rise and a five-year-old document does not.
//
// Nothing here reads the database, and nothing here knows about RLS. What a
// caller may see is decided in `lib/services/search`, before a hit ever
// reaches this file.

/** The record types household search can return. One per source table. */
export const SEARCH_KINDS = [
  'document', 'item', 'trip', 'vacation', 'bill', 'warranty',
  'renewal', 'decision', 'event', 'note', 'fact',
] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

/**
 * Per-kind display metadata and ranking weight.
 *
 * `label` is the English a developer reads here; `labelKey` is what the UI
 * renders through `t()`, so this array can stay a plain module-level constant
 * without smuggling untranslated copy into a screen.
 */
export const SEARCH_KIND_META: ReadonlyArray<{
  kind: SearchKind;
  label: string;
  labelKey: string;
  /** Added to the match score. Small — a tie-breaker, not an override. */
  weight: number;
}> = [
  { kind: 'bill', label: 'Bill', labelKey: 'search.kindBill', weight: 8 },
  { kind: 'warranty', label: 'Warranty', labelKey: 'search.kindWarranty', weight: 8 },
  { kind: 'renewal', label: 'Renewal', labelKey: 'search.kindRenewal', weight: 7 },
  { kind: 'document', label: 'Document', labelKey: 'search.kindDocument', weight: 6 },
  { kind: 'event', label: 'Event', labelKey: 'search.kindEvent', weight: 6 },
  { kind: 'item', label: 'Item', labelKey: 'search.kindItem', weight: 5 },
  { kind: 'trip', label: 'Trip', labelKey: 'search.kindTrip', weight: 4 },
  { kind: 'vacation', label: 'Vacation', labelKey: 'search.kindVacation', weight: 4 },
  { kind: 'decision', label: 'Decision', labelKey: 'search.kindDecision', weight: 3 },
  { kind: 'fact', label: 'Memory', labelKey: 'search.kindFact', weight: 2 },
  { kind: 'note', label: 'Note', labelKey: 'search.kindNote', weight: 1 },
];

const KIND_WEIGHT: Record<SearchKind, number> = Object.fromEntries(
  SEARCH_KIND_META.map((m) => [m.kind, m.weight]),
) as Record<SearchKind, number>;

const KIND_ORDER: Record<SearchKind, number> = Object.fromEntries(
  SEARCH_KIND_META.map((m, i) => [m.kind, i]),
) as Record<SearchKind, number>;

/** The catalogue key for a kind's label, so a caller never hand-writes one. */
export function kindLabelKey(kind: SearchKind): string {
  return SEARCH_KIND_META.find((m) => m.kind === kind)?.labelKey ?? 'search.kindNote';
}

/**
 * One result, and the evidence for it.
 *
 * `table` and `occurredAt` are not decoration: a search that says "here is a
 * warranty" without saying which row it came from and when it is dated is
 * asking to be trusted rather than checked. `href` is always an EXISTING route
 * — search invents no destinations.
 */
export type SearchHit = {
  kind: SearchKind;
  id: string;
  title: string;
  /** A short line of context — the body, the destination, the amount. */
  snippet: string | null;
  /** The source table the row was read from. */
  table: string;
  /** The date this record is about (or was last touched), ISO; null when it has none. */
  occurredAt: string | null;
  /** Deep link to the page that already shows this record. */
  href: string;
  /** Filled in by `rankHits`; 0 until then. */
  score: number;
};

/** A title match is worth its full score; a body match is worth this much of it. */
export const SNIPPET_WEIGHT = 0.4;

/**
 * The floor for a row the database matched on a column the card does not show
 * — a serial number, a policy number, a note. Dropping it because the visible
 * title does not contain the query would hide a real answer, so it ranks last
 * instead of vanishing.
 */
export const MATCHED_FLOOR = 10;

/**
 * How well `query` matches one piece of text. 0 means no match at all.
 *
 * The tiers mirror `navMatchScore` in `lib/command-bar/route.ts` deliberately:
 * two ranked lists appear in the same palette, and a user should not have to
 * learn that "starts with" means something different for a page than for a
 * record.
 */
export function textMatchScore(query: string, text: string | null | undefined): number {
  const q = query.trim().toLowerCase();
  const value = (text ?? '').trim().toLowerCase();
  if (!q || !value) return 0;
  if (value === q) return 100;
  if (value.startsWith(q)) return 80;
  if (value.split(/\s+/).some((word) => word.startsWith(q))) return 60;
  if (value.includes(q)) return 40;
  // "warranty furnace" should still find "Furnace warranty — Carrier": every
  // word is present, just not in that order. Weakest tier, above nothing.
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length > 1 && terms.every((term) => value.includes(term))) return 30;
  return 0;
}

/**
 * Closeness in time, as a small additive bonus.
 *
 * The distance is absolute, so the trip three weeks out ranks with the receipt
 * three weeks past: "recent" for a household means "near now", not "already
 * happened". A record with no date gets nothing rather than a penalty — a note
 * is not less relevant for being undated.
 */
export function recencyBoost(occurredAt: string | null | undefined, now: Date = new Date()): number {
  if (!occurredAt) return 0;
  const ms = Date.parse(occurredAt);
  if (!Number.isFinite(ms)) return 0;
  const days = Math.abs(now.getTime() - ms) / 86_400_000;
  if (days <= 7) return 12;
  if (days <= 30) return 8;
  if (days <= 180) return 4;
  if (days <= 365) return 2;
  return 0;
}

/** The whole score for one hit: how it matched, what it is, how near it is. */
export function scoreHit(query: string, hit: Omit<SearchHit, 'score'>, now: Date = new Date()): number {
  const title = textMatchScore(query, hit.title);
  const snippet = textMatchScore(query, hit.snippet) * SNIPPET_WEIGHT;
  const base = Math.max(title, snippet, MATCHED_FLOOR);
  return Math.round(base + (KIND_WEIGHT[hit.kind] ?? 0) + recencyBoost(hit.occurredAt, now));
}

/** Newest first; a hit with no date sorts after one that has one. */
function byDateDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return Date.parse(b) - Date.parse(a);
}

/**
 * Score and order hits. Deterministic all the way down — score, then date,
 * then title, then id — because a search that reorders equal results between
 * two renders looks broken even when it is not.
 */
export function rankHits(
  query: string,
  hits: ReadonlyArray<Omit<SearchHit, 'score'>>,
  opts: { now?: Date; limit?: number } = {},
): SearchHit[] {
  const now = opts.now ?? new Date();
  const scored = hits.map((hit) => ({ ...hit, score: scoreHit(query, hit, now) }));
  scored.sort((a, b) => (
    b.score - a.score
    || byDateDesc(a.occurredAt, b.occurredAt)
    || a.title.localeCompare(b.title)
    || a.id.localeCompare(b.id)
  ));
  return typeof opts.limit === 'number' ? scored.slice(0, Math.max(0, opts.limit)) : scored;
}

/**
 * Hits grouped for the results page, in `SEARCH_KIND_META` order so the groups
 * do not jump around between queries. Empty groups are omitted — a heading
 * over nothing is noise.
 */
export function groupByKind(hits: ReadonlyArray<SearchHit>): Array<{ kind: SearchKind; hits: SearchHit[] }> {
  const groups = new Map<SearchKind, SearchHit[]>();
  for (const hit of hits) {
    const bucket = groups.get(hit.kind);
    if (bucket) bucket.push(hit);
    else groups.set(hit.kind, [hit]);
  }
  return [...groups.entries()]
    .sort((a, b) => (KIND_ORDER[a[0]] ?? 99) - (KIND_ORDER[b[0]] ?? 99))
    .map(([kind, kindHits]) => ({ kind, hits: kindHits }));
}
