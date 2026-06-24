import 'server-only';
import { normalizeThemealdb } from '@/lib/recipes/normalize';
import type { NormalizedRecipe, RecipeProvider } from '@/lib/recipes/providers/types';

// TheMealDB — free, keyless (public test key "1"). A paid key can be supplied
// via THEMEALDB_API_KEY to lift rate limits, but it's optional by design.
const KEY = process.env.THEMEALDB_API_KEY || '1';
const BASE = `https://www.themealdb.com/api/json/v1/${KEY}`;

async function getJson(url: string): Promise<{ meals: Record<string, string>[] | null }> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`TheMealDB ${res.status}`);
  return res.json();
}

export const themealdb: RecipeProvider = {
  id: 'themealdb',
  label: 'TheMealDB',
  isEnabled: () => true, // keyless
  async search(query, opts) {
    const q = query.trim();
    if (!q) return [];
    const data = await getJson(`${BASE}/search.php?s=${encodeURIComponent(q)}`);
    const meals = data.meals ?? [];
    const out = meals.map(normalizeThemealdb);
    return typeof opts?.limit === 'number' ? out.slice(0, opts.limit) : out;
  },
  async lookup(sourceRecipeId): Promise<NormalizedRecipe | null> {
    const data = await getJson(`${BASE}/lookup.php?i=${encodeURIComponent(sourceRecipeId)}`);
    const meal = data.meals?.[0];
    return meal ? normalizeThemealdb(meal) : null;
  },
};
