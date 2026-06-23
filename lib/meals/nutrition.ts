// lib/meals/nutrition.ts — pure helpers for AI Nutrition Analysis.
// The model returns a strict JSON shape; we parse, validate, aggregate, and
// format it here so the route + UI stay thin.

export interface Nutrition {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  sodium_mg: number;
}

export interface MealNutrition extends Nutrition {
  label: string;
  servings: number;
}

const KEYS: (keyof Nutrition)[] = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg'];

/** FDA-style reference daily values (per adult, per day) for the % bars. */
export const DAILY_VALUES: Nutrition = {
  calories: 2000, protein_g: 50, carbs_g: 275, fat_g: 78, fiber_g: 28, sugar_g: 50, sodium_mg: 2300,
};

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0;
}

/** Coerce arbitrary parsed JSON into a clean Nutrition object (missing → 0). */
export function coerceNutrition(raw: unknown): Nutrition {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    calories: Math.round(num(o.calories)),
    protein_g: num(o.protein_g),
    carbs_g: num(o.carbs_g),
    fat_g: num(o.fat_g),
    fiber_g: num(o.fiber_g),
    sugar_g: num(o.sugar_g),
    sodium_mg: num(o.sodium_mg),
  };
}

/**
 * Extract the first JSON object from a model completion (it may wrap JSON in
 * prose or ```json fences). Returns null if nothing parseable is found.
 */
export function parseModelJSON(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Sum a list of meal nutritions into a single total. */
export function sumNutrition(items: Nutrition[]): Nutrition {
  const out: Nutrition = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 0 };
  for (const it of items) for (const k of KEYS) out[k] += it[k] ?? 0;
  for (const k of KEYS) out[k] = Math.round(out[k] * 10) / 10;
  return out;
}

/** Average per day across `days` (defaults to 7 for a planned week). */
export function perDay(total: Nutrition, days = 7): Nutrition {
  const d = Math.max(1, days);
  const out = {} as Nutrition;
  for (const k of KEYS) out[k] = Math.round((total[k] / d) * 10) / 10;
  return out;
}

/** Percentage of the reference daily value (capped at 999 for display). */
export function dailyValuePct(key: keyof Nutrition, value: number): number {
  const dv = DAILY_VALUES[key];
  if (!dv) return 0;
  return Math.min(999, Math.round((value / dv) * 100));
}

export function fmtAmount(key: keyof Nutrition, value: number): string {
  if (key === 'calories') return `${Math.round(value)} kcal`;
  if (key === 'sodium_mg') return `${Math.round(value)} mg`;
  return `${value} g`;
}

export const NUTRIENT_LABELS: Record<keyof Nutrition, string> = {
  calories: 'Calories', protein_g: 'Protein', carbs_g: 'Carbs', fat_g: 'Fat',
  fiber_g: 'Fiber', sugar_g: 'Sugar', sodium_mg: 'Sodium',
};
