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

/**
 * Search across every enabled provider, de-duped by provider+id.
 *
 * THROWS when no provider answered — none enabled, or every one failed — so
 * the route can say the search is unavailable. Dropping every rejected
 * provider and returning what was left made an outage of the only provider an
 * empty list at HTTP 200, and the screen said "No recipes found". `partial`
 * says some providers answered and some did not.
 */
export async function searchAllProviders(
  query: string, opts?: { limit?: number },
): Promise<{ recipes: NormalizedRecipe[]; partial: boolean }> {
  const providers = enabledProviders();
  if (providers.length === 0) throw new Error('No recipe provider is enabled.');
  const results = await Promise.allSettled(providers.map((p) => p.search(query, opts)));
  const failed = results.filter((r) => r.status !== 'fulfilled').length;
  if (failed === results.length) {
    const first = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    throw new Error('Every recipe provider failed.', { cause: first?.reason });
  }
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
  return { recipes: typeof opts?.limit === 'number' ? merged.slice(0, opts.limit) : merged, partial: failed > 0 };
}
