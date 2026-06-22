// Recipe normalization — converts provider payloads into NormalizedRecipe.
// Pure (no network/deps) so it's unit tested.

import type { NormalizedIngredient, NormalizedRecipe, NormalizedStep } from '@/lib/recipes/providers/types';

/** Split free-text instructions into numbered steps. */
export function normalizeInstructions(text: string | null | undefined): NormalizedStep[] {
  if (!text) return [];
  let parts = text.split(/\r?\n+/).map((s) => s.replace(/^\s*(?:step\s*)?\d+[).:-]?\s*/i, '').trim()).filter(Boolean);
  // Single blob → split into sentences as a fallback.
  if (parts.length <= 1) {
    parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return parts.map((t, i) => ({ step: i + 1, text: t }));
}

/** Parse a measure string like "1 1/2 cups" into quantity + unit (best-effort). */
export function normalizeMeasure(measure: string | null | undefined): { quantity: string; unit: string } {
  const m = (measure ?? '').trim();
  if (!m) return { quantity: '', unit: '' };
  // Leading amount = digits, fractions, decimals, ranges, unicode fractions.
  const match = /^([\d\s./¼½¾⅓⅔⅛–-]+)\s*(.*)$/.exec(m);
  if (match && match[1].trim()) return { quantity: match[1].trim(), unit: match[2].trim() };
  return { quantity: m, unit: '' };
}

type MealDbMeal = Record<string, string | null | undefined> & {
  idMeal?: string; strMeal?: string; strCategory?: string; strArea?: string;
  strInstructions?: string; strMealThumb?: string; strTags?: string;
  strSource?: string; strYoutube?: string;
};

/** TheMealDB meal object → NormalizedRecipe. */
export function normalizeThemealdb(meal: MealDbMeal): NormalizedRecipe {
  const ingredients: NormalizedIngredient[] = [];
  for (let i = 1; i <= 20; i++) {
    const name = (meal[`strIngredient${i}`] ?? '').toString().trim();
    if (!name) continue;
    const { quantity, unit } = normalizeMeasure(meal[`strMeasure${i}`]?.toString());
    ingredients.push({ name, quantity, unit });
  }
  const tags = (meal.strTags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const id = (meal.idMeal ?? '').toString();
  const sourceUrl = meal.strSource?.trim() || meal.strYoutube?.trim() || (id ? `https://www.themealdb.com/meal/${id}` : null);

  return {
    sourceProvider: 'themealdb',
    sourceRecipeId: id,
    sourceUrl: sourceUrl || null,
    attribution: 'Recipe via TheMealDB',
    licenseNotes: 'Data from TheMealDB (themealdb.com). Free to use; please keep attribution.',
    name: (meal.strMeal ?? 'Untitled recipe').toString().trim(),
    description: null,
    category: (meal.strCategory ?? 'other').toString().trim().toLowerCase() || 'other',
    cuisine: meal.strArea?.toString().trim() || null,
    photoUrl: meal.strMealThumb?.toString().trim() || null,
    tags,
    ingredients,
    instructions: normalizeInstructions(meal.strInstructions),
    raw: meal,
  };
}
