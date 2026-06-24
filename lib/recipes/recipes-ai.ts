export type RecipesInsights = {
  totalRecipes: number;
  categoryCounts: Record<string, number>;
  avgPrepTime: number | null;
  favoriteCount: number;
  summary: string;
};

export interface RecipeForAI {
  name: string;
  category: string;
  cuisine: string | null;
  difficulty: string;
  prep_time_mins: number | null;
  cook_time_mins: number | null;
  is_favorite: boolean;
}

export function analyzeRecipes(recipes: RecipeForAI[]): RecipesInsights {
  const categoryCounts: Record<string, number> = {};
  let totalPrep = 0;
  let prepCount = 0;
  let favoriteCount = 0;

  for (const r of recipes) {
    categoryCounts[r.category] = (categoryCounts[r.category] ?? 0) + 1;
    if (r.prep_time_mins != null) { totalPrep += r.prep_time_mins; prepCount++; }
    if (r.is_favorite) favoriteCount++;
  }

  const avgPrepTime = prepCount > 0 ? Math.round(totalPrep / prepCount) : null;
  const summary = recipes.length === 0
    ? 'No recipes in the collection yet.'
    : `${recipes.length} recipes across ${Object.keys(categoryCounts).length} categories. ${favoriteCount} favorites.`;

  return { totalRecipes: recipes.length, categoryCounts, avgPrepTime, favoriteCount, summary };
}

export function buildRecipesPrompt(recipes: RecipeForAI[]) {
  const system = `You are a family recipe advisor. Analyze recipe data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"cookingTips":["..."],"varietyTip":"..."}
suggestions: up to 4 actionable ideas. cookingTips: up to 3 tips. varietyTip: one sentence about adding variety.`;

  const user = `Recipe collection:\n${JSON.stringify(recipes.slice(0, 50))}`;
  return { system, user };
}

export type RecipesAIResponse = {
  suggestions: string[];
  cookingTips: string[];
  varietyTip: string;
};

export function parseRecipesResponse(raw: string): RecipesAIResponse {
  const empty: RecipesAIResponse = { suggestions: [], cookingTips: [], varietyTip: '' };
  if (!raw || typeof raw !== 'string') return empty;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
      cookingTips: Array.isArray(parsed.cookingTips) ? parsed.cookingTips.filter((s): s is string => typeof s === 'string').slice(0, 3) : [],
      varietyTip: typeof parsed.varietyTip === 'string' ? parsed.varietyTip : '',
    };
  } catch { return empty; }
}
