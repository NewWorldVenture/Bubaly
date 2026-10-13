// lib/meals/pantry-chef.ts — the "Fridge Chef" engine.
// Pure, dependency-free logic behind /api/ai/pantry-chef: build the vision
// prompt (allergy-aware), parse the model's recipe JSON robustly, and flag any
// suggestion that conflicts with a family allergy (defense-in-depth in case the
// model slips). Kept side-effect-free so it unit-tests without a network/DB.
import { isValidTimezone, localPartsAt } from '@/lib/time/zoned';
import { allergenConflict } from '@/lib/meals/substitutions';

export type PantryRecipe = {
  title: string;
  /** Ingredients the photo shows the family already has. */
  have: string[];
  /** Ingredients the family must buy — feed straight into the grocery list. */
  need: string[];
  /** Short method summary. */
  steps: string;
  /** Estimated hands-on minutes, when the model gives one. */
  minutes: number | null;
  /** Set to the matched allergy term when a suggestion conflicts with one. */
  allergenConflict: string | null;
};

/** Split the free-text `medical_profiles.allergies` field into distinct terms. */
export function normalizeAllergies(...raw: Array<string | null | undefined>): string[] {
  const terms = raw
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .flatMap((v) => v.split(/[,;/]|\band\b|\n/i))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1 && !['none', 'n/a', 'na', 'nka', 'no known allergies'].includes(t));
  return [...new Set(terms)];
}

/**
 * Vision prompt: identify what's in the photo and propose allergy-safe dinners.
 * "Today" is the FAMILY's day (`tz`): rendered on the host's clock, a family in
 * California planning dinner at 8pm was told it was tomorrow.
 */
export function buildPantryChefPrompt(allergies: string[], now: Date, tz: string): string {
  const today = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz });
  const allergyLine = allergies.length
    ? `The family has these allergies/intolerances — NEVER suggest a recipe containing them or their common derivatives: ${allergies.join(', ')}.`
    : 'No known family allergies were provided.';
  return `You are a family dinner assistant. Look at this photo of a fridge/pantry and identify the food you can see. Today is ${today}.

${allergyLine}

Propose 3 realistic dinner recipes the family could make mostly from what's visible, needing only a few common extra items.

Return ONLY a JSON array (no markdown, no prose). Each item:
{"title": string, "have": string[] (ingredients visible in the photo), "need": string[] (a few items to buy), "steps": string (2-4 sentence method), "minutes": number or null}

Rules:
- Keep "need" short (ideally ≤5 items) — favour recipes that use what's already there.
- Do NOT include any allergen listed above in "have" or "need".
- If the photo shows no food, return [].`;
}

/**
 * The longest ingredient or grocery name Fridge Chef will carry, matching the
 * services it feeds: `addItems` (lib/services/groceries) and `validIngredients`
 * (lib/services/meals) both refuse a name over 300 characters. A recipe that
 * carried one into a planned meal made "add this week's plan to the list" fail
 * for the whole week with "Check the items to add.", so it is dropped here,
 * where it first arrives.
 */
export const MAX_PANTRY_ITEM_CHARS = 300;

/** Trimmed, non-empty strings no longer than the services accept, at most `max` of them. */
export function boundedNames(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0 && v.length <= MAX_PANTRY_ITEM_CHARS)
    .slice(0, max);
}

function coerceStringArray(value: unknown): string[] {
  return boundedNames(value, 25);
}

/** Robustly parse the model's reply (fenced or bare JSON) into recipes. */
export function parsePantryRecipes(text: string): PantryRecipe[] {
  return readPantryRecipes(text) ?? [];
}

/**
 * The same parse, telling "the model said there is no food" (a JSON `[]`) apart
 * from "the model said nothing this can read": null for a refusal, prose, an
 * empty reply or an array cut off at the token limit. Only the first is "No
 * food spotted"; the second is a photo that could not be read.
 */
export function readPantryRecipes(text: string): PantryRecipe[] | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).match(/\[[\s\S]*\]/)?.[0];
  if (!candidate) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  return raw
    .map((r): PantryRecipe | null => {
      if (!r || typeof r !== 'object') return null;
      const o = r as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      if (!title) return null;
      const minutesRaw = o.minutes;
      const minutes = typeof minutesRaw === 'number' && Number.isFinite(minutesRaw)
        ? Math.max(0, Math.round(minutesRaw))
        : null;
      return {
        title,
        have: coerceStringArray(o.have),
        need: coerceStringArray(o.need),
        steps: typeof o.steps === 'string' ? o.steps.trim() : '',
        minutes,
        allergenConflict: null,
      };
    })
    .filter((r): r is PantryRecipe => r !== null)
    .slice(0, 6);
}

/**
 * Validate a caller-supplied plan date (YYYY-MM-DD, a real calendar day);
 * anything else uses the household's captured today. The zone is required:
 * an unknown household clock must never quietly become a different dinner day.
 */
export function normalizePlanDate(value: unknown, timezone: string, now: Date = new Date()): string {
  if (typeof timezone !== 'string' || !timezone.trim() || !isValidTimezone(timezone) || !Number.isFinite(now.getTime())) {
    throw new RangeError('The household dinner date cannot be determined.');
  }
  const { year, month, day } = localPartsAt(now, timezone);
  const today = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return today;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return today;
  return value;
}

/**
 * Defense-in-depth: flag (don't silently drop) any recipe whose title, have,
 * need or method runs into a family allergy, so the UI can warn or exclude it
 * even if the model ignored the prompt.
 *
 * Through `allergenConflict` (lib/meals/substitutions), not a substring test:
 * "peanuts" is not a substring of "peanut butter", "tree nuts" names no almond,
 * "severe peanut allergy (epipen)" is a substring of nothing, and an allergen
 * named only in the steps ("finish with cashews") was never looked at.
 */
export function annotateAllergens(recipes: PantryRecipe[], allergies: string[]): PantryRecipe[] {
  if (allergies.length === 0) return recipes;
  return recipes.map((recipe) => ({
    ...recipe,
    allergenConflict: allergenConflict([recipe.title, ...recipe.have, ...recipe.need, recipe.steps], allergies),
  }));
}
