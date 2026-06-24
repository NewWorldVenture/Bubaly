export type MealsInsights = {
  totalMeals: number;
  mealTypeCounts: Record<string, number>;
  summary: string;
};

export interface MealForAI {
  name: string;
  meal_type: string;
  notes: string | null;
}

export function analyzeMeals(meals: MealForAI[]): MealsInsights {
  const mealTypeCounts: Record<string, number> = {};

  for (const m of meals) {
    mealTypeCounts[m.meal_type] = (mealTypeCounts[m.meal_type] ?? 0) + 1;
  }

  const summary = meals.length === 0
    ? 'No meals in the library yet.'
    : `${meals.length} meals across ${Object.keys(mealTypeCounts).length} types.`;

  return { totalMeals: meals.length, mealTypeCounts, summary };
}

export function buildMealsPrompt(meals: MealForAI[]) {
  const system = `You are a family meal planning advisor. Analyze meal data and return ONLY valid JSON with this shape:
{"suggestions":["..."],"mealIdeas":["..."],"nutritionTip":"..."}
suggestions: up to 4 actionable ideas. mealIdeas: up to 3 new meal ideas. nutritionTip: one sentence about nutrition.`;

  const user = `Meal library:\n${JSON.stringify(meals.slice(0, 50))}`;
  return { system, user };
}

export type MealsAIResponse = {
  suggestions: string[];
  mealIdeas: string[];
  nutritionTip: string;
};

export function parseMealsResponse(raw: string): MealsAIResponse {
  const empty: MealsAIResponse = { suggestions: [], mealIdeas: [], nutritionTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      mealIdeas: Array.isArray(parsed.mealIdeas)
        ? parsed.mealIdeas.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      nutritionTip: typeof parsed.nutritionTip === 'string' ? parsed.nutritionTip : '',
    };
  } catch {
    return empty;
  }
}
