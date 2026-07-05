// Family Playbook — pure, unit-tested learning logic (north-star pillar #3).
// Turns normalized household signals (favorite meals, grocery staples, explicit
// favorites, annual traditions) into candidate "playbook" facts the family can
// confirm into their Knowledge Base. Deterministic + DB-free so the inference
// rules are tested in isolation; the server does the SQL aggregation and feeds
// the counts in here. What you see suggested == what gets saved on confirm.

/** The family_facts category an accepted suggestion maps to 1:1. */
export type FactCategory =
  | 'about' | 'preference' | 'medical' | 'contact' | 'sizes' | 'important' | 'account' | 'date' | 'other';

/** Normalized evidence the server gathers from real, family-scoped tables. */
export type PlaybookSignal =
  // A meal planned repeatedly → a go-to dinner. `count` = times on the plan.
  | { type: 'meal'; name: string; count: number }
  // A grocery item added to the list repeatedly → a household staple.
  | { type: 'grocery'; name: string; count: number }
  // An explicit family favorite (family_favorites), optionally per-member.
  | { type: 'favorite'; kind: string; name: string; memberId?: string | null; rating?: number | null }
  // A calendar event that recurs around the same date across years → tradition.
  | { type: 'tradition'; title: string; when: string; years: number }
  // A recurring travel pattern (trip kind or season) → travel style. `count` =
  // trips fitting the style.
  | { type: 'travel'; style: string; count: number };

export type PlaybookSuggestion = {
  signature: string;            // stable dedupe key (survives re-runs)
  memberId: string | null;      // who it's about (null = whole family)
  category: FactCategory;
  label: string;                // the fact label ("Go-to dinner")
  value: string;                // the fact value ("Taco night")
  evidence: string;             // human "why we think so"
  confidence: number;           // 0..100
};

/** Minimum signal strength before we bother suggesting anything. */
const MIN = { meal: 3, grocery: 4, tradition: 2, travel: 3 } as const;

/** Default cap so a busy family's inbox stays reviewable, not overwhelming. */
export const DEFAULT_SUGGESTION_CAP = 24;

const clampConf = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/** Lowercase, trim, collapse runs of non-alphanumerics to single dashes. */
export function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Title-case-ish tidy of a raw name for display in a fact value. */
function tidy(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** Turn one signal into a candidate suggestion, or null if below threshold. */
function fromSignal(sig: PlaybookSignal): PlaybookSuggestion | null {
  switch (sig.type) {
    case 'meal': {
      if (sig.count < MIN.meal) return null;
      const value = tidy(sig.name);
      if (!value) return null;
      return {
        signature: `meal:${slug(value)}`,
        memberId: null,
        category: 'preference',
        label: 'Go-to dinner',
        value,
        evidence: `Planned ${sig.count} times recently`,
        confidence: clampConf(50 + sig.count * 8),
      };
    }
    case 'grocery': {
      if (sig.count < MIN.grocery) return null;
      const value = tidy(sig.name);
      if (!value) return null;
      return {
        signature: `grocery:${slug(value)}`,
        memberId: null,
        category: 'preference',
        label: 'Grocery staple',
        value,
        evidence: `Added to the list ${sig.count} times`,
        confidence: clampConf(45 + sig.count * 5),
      };
    }
    case 'favorite': {
      const value = tidy(sig.name);
      if (!value) return null;
      const kind = tidy(sig.kind) || 'thing';
      const memberId = sig.memberId ?? null;
      const rating = sig.rating ?? null;
      return {
        signature: `fav:${slug(kind)}:${slug(value)}:${memberId ?? 'family'}`,
        memberId,
        category: 'preference',
        label: `Favorite ${kind.toLowerCase()}`,
        value,
        evidence: rating ? `Rated ${rating}/5` : 'Marked a family favorite',
        confidence: clampConf(rating ? 55 + rating * 8 : 65),
      };
    }
    case 'tradition': {
      if (sig.years < MIN.tradition) return null;
      const value = tidy(sig.title);
      if (!value) return null;
      return {
        signature: `tradition:${slug(value)}`,
        memberId: null,
        category: 'date',
        label: 'Family tradition',
        value,
        evidence: `Happened ${sig.years} years running around ${tidy(sig.when)}`,
        confidence: clampConf(55 + sig.years * 10),
      };
    }
    case 'travel': {
      if (sig.count < MIN.travel) return null;
      const value = tidy(sig.style);
      if (!value) return null;
      return {
        signature: `travel:${slug(value)}`,
        memberId: null,
        category: 'preference',
        label: 'Travel style',
        value,
        evidence: `${sig.count} of your trips fit this`,
        confidence: clampConf(48 + sig.count * 7),
      };
    }
  }
}

/**
 * Learn a ranked, deduped set of playbook suggestions from raw signals.
 * - Signals below their threshold are dropped.
 * - Duplicate signatures collapse to the highest-confidence instance.
 * - Sorted by confidence desc, then label, then value (stable, deterministic).
 * - Capped to `cap` (default DEFAULT_SUGGESTION_CAP).
 */
export function learnPlaybook(
  signals: PlaybookSignal[],
  opts: { cap?: number } = {},
): PlaybookSuggestion[] {
  const cap = opts.cap ?? DEFAULT_SUGGESTION_CAP;
  const bySig = new Map<string, PlaybookSuggestion>();
  for (const s of signals) {
    const cand = fromSignal(s);
    if (!cand) continue;
    const prev = bySig.get(cand.signature);
    if (!prev || cand.confidence > prev.confidence) bySig.set(cand.signature, cand);
  }
  return [...bySig.values()]
    .sort((a, b) =>
      b.confidence - a.confidence
      || a.label.localeCompare(b.label)
      || a.value.localeCompare(b.value))
    .slice(0, Math.max(0, cap));
}
