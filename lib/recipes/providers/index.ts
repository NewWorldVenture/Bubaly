import 'server-only';
import { themealdb } from '@/lib/recipes/providers/themealdb';
import type { NormalizedRecipe, RecipeProvider } from '@/lib/recipes/providers/types';

// Provider registry. Add new adapters here; each is optional and self-reports
// whether it's enabled (keyless providers are always on; keyed ones require env).
// Future adapters (stubs to add): usda, openFoodFacts, spoonacular, edamam,
// fatsecret, localSupabase — see docs/AGENT_HANDOFF.md roadmap.
const ALL: RecipeProvider[] = [themealdb];

export function enabledProviders(): RecipeProvider[] {
  return ALL.filter((p) => p.isEnabled());
}

export function getProvider(id: string): RecipeProvider | undefined {
  return ALL.find((p) => p.id === id && p.isEnabled());
}

/** Search across every enabled provider, de-duped by provider+id. */
export async function searchAllProviders(query: string, opts?: { limit?: number }): Promise<NormalizedRecipe[]> {
  const providers = enabledProviders();
  const results = await Promise.allSettled(providers.map((p) => p.search(query, opts)));
  const merged: NormalizedRecipe[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const recipe of r.value) {
      const key = `${recipe.sourceProvider}:${recipe.sourceRecipeId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(recipe);
    }
  }
  return typeof opts?.limit === 'number' ? merged.slice(0, opts.limit) : merged;
}
