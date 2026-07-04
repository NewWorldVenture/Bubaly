// Family Knowledge Base — pure, unit-tested logic for the persistent family
// facts store. Categories, filtering, search, and pinned-first grouping live
// here so the module stays declarative and the rules are tested without a DB.

export type FactCategory =
  | 'about' | 'preference' | 'medical' | 'contact' | 'sizes' | 'important' | 'account' | 'date' | 'other';

export const FACT_CATEGORY_LABELS: Record<FactCategory, string> = {
  about: 'About', preference: 'Preferences', medical: 'Medical', contact: 'Contacts',
  sizes: 'Sizes', important: 'Important', account: 'Accounts', date: 'Dates', other: 'Other',
};

export const FACT_CATEGORY_ORDER: FactCategory[] = [
  'important', 'medical', 'contact', 'sizes', 'preference', 'account', 'date', 'about', 'other',
];

export type FactLike = {
  id: string;
  member_id: string | null;
  category: string;
  label: string;
  value: string;
  notes: string | null;
  is_pinned: boolean;
  updated_at: string;
};

export type FactFilter = { member?: string | 'all' | 'family'; category?: FactCategory | 'all'; q?: string };

/** Case-insensitive match of a query against a fact's label, value, and notes. */
export function factMatches(fact: FactLike, needle: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  return fact.label.toLowerCase().includes(n)
    || fact.value.toLowerCase().includes(n)
    || (fact.notes ?? '').toLowerCase().includes(n);
}

/**
 * Filter facts by member ('family' = only family-level, 'all' = everything),
 * category, and a text query. Sort pinned-first, then most-recently-updated.
 */
export function filterFacts<T extends FactLike>(rows: T[], filter: FactFilter = {}): T[] {
  const { member = 'all', category = 'all', q = '' } = filter;
  const needle = q.trim().toLowerCase();
  const out = rows.filter((f) => {
    if (member === 'family' && f.member_id !== null) return false;
    if (member !== 'all' && member !== 'family' && f.member_id !== member) return false;
    if (category !== 'all' && f.category !== category) return false;
    if (!factMatches(f, needle)) return false;
    return true;
  });
  return out.sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

/** Group facts by category, in FACT_CATEGORY_ORDER, keeping input order within. */
export function groupByCategory<T extends FactLike>(rows: T[]): [FactCategory, T[]][] {
  const map = new Map<FactCategory, T[]>();
  for (const f of rows) {
    const c = (FACT_CATEGORY_LABELS[f.category as FactCategory] ? f.category : 'other') as FactCategory;
    const arr = map.get(c) ?? [];
    arr.push(f); map.set(c, arr);
  }
  return FACT_CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => [c, map.get(c)!]);
}

/** Count of distinct facts (for the header). */
export function factCount<T extends FactLike>(rows: T[]): number {
  return rows.length;
}
