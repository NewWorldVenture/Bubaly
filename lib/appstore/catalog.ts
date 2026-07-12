// lib/appstore/catalog.ts — pure Family App Store catalog helpers (unit-tested).

export const APP_CATEGORIES = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'meals', label: 'Meals' },
  { key: 'chores', label: 'Chores' },
  { key: 'school', label: 'School' },
  { key: 'sports', label: 'Sports' },
  { key: 'health', label: 'Health' },
  { key: 'finance', label: 'Finance' },
  { key: 'travel', label: 'Travel' },
  { key: 'safety', label: 'Safety' },
  { key: 'home', label: 'Home' },
  { key: 'ai_agents', label: 'AI Agents' },
  { key: 'other', label: 'Other' },
] as const;

export type AppCategory = (typeof APP_CATEGORIES)[number]['key'];

export const categoryLabel = (key: string): string =>
  APP_CATEGORIES.find((c) => c.key === key)?.label ?? 'Other';

export type CatalogApp = {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  category: string;
  emoji: string | null;
  publisher: string;
  capabilities: string[];
  is_official: boolean;
  rating: number | null;
  install_count: number;
  status: string;
};

/** Filter the catalog by category ('all' = any) and a free-text query. */
export function filterApps<T extends CatalogApp>(
  apps: T[], opts: { category?: string; q?: string } = {},
): T[] {
  const category = opts.category && opts.category !== 'all' ? opts.category : null;
  const q = (opts.q ?? '').trim().toLowerCase();
  return apps.filter((a) => {
    if (a.status === 'retired') return false;
    if (category && a.category !== category) return false;
    if (q) {
      const hay = `${a.name} ${a.tagline ?? ''} ${a.publisher} ${a.capabilities.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Rank: official first, then rating desc, then install_count desc, then name. */
export function rankApps<T extends CatalogApp>(apps: T[]): T[] {
  return [...apps].sort((a, b) => {
    if (a.is_official !== b.is_official) return a.is_official ? -1 : 1;
    const r = (b.rating ?? 0) - (a.rating ?? 0);
    if (r !== 0) return r;
    const ic = b.install_count - a.install_count;
    if (ic !== 0) return ic;
    return a.name.localeCompare(b.name);
  });
}

/**
 * "Recommended for your family": bias toward the categories the family already
 * engages with (from signals), highest-rated + official, excluding installed.
 * Pure — the caller supplies engaged categories + installed ids.
 */
export function recommendedApps<T extends CatalogApp>(
  apps: T[], opts: { engagedCategories?: string[]; installedIds?: Set<string>; limit?: number } = {},
): T[] {
  const engaged = new Set(opts.engagedCategories ?? []);
  const installed = opts.installedIds ?? new Set<string>();
  const pool = apps.filter((a) => a.status !== 'retired' && a.status !== 'coming_soon' && !installed.has(a.id));
  const scored = pool.map((a) => ({
    a,
    score: (engaged.has(a.category) ? 100 : 0) + (a.rating ?? 0) * 10 + (a.is_official ? 5 : 0),
  }));
  scored.sort((x, y) => y.score - x.score || y.a.install_count - x.a.install_count);
  return scored.slice(0, opts.limit ?? 6).map((s) => s.a);
}
