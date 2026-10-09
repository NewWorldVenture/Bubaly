// lib/meals/pantry-chef.ts — the "Fridge Chef" engine.
// Pure, dependency-free logic behind /api/ai/pantry-chef: build the vision
// prompt (allergy-aware), parse the model's recipe JSON robustly, and flag any
// suggestion that conflicts with a family allergy (defense-in-depth in case the
// model slips). Kept side-effect-free so it unit-tests without a network/DB.
import { isValidTimezone, localPartsAt } from '@/lib/time/zoned';

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

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0)
    .slice(0, 25);
}

/** Robustly parse the model's reply (fenced or bare JSON) into recipes. */
export function parsePantryRecipes(text: string): PantryRecipe[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).match(/\[[\s\S]*\]/)?.[0];
  if (!candidate) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
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
 * Defense-in-depth: flag (don't silently drop) any recipe whose title/have/need
 * mentions a family allergy term, so the UI can warn or exclude it even if the
 * model ignored the prompt.
 */
export function annotateAllergens(recipes: PantryRecipe[], allergies: string[]): PantryRecipe[] {
  if (allergies.length === 0) return recipes;
  return recipes.map((recipe) => {
    const haystack = [recipe.title, ...recipe.have, ...recipe.need].join(' ').toLowerCase();
    const hit = allergies.find((term) => haystack.includes(term));
    return { ...recipe, allergenConflict: hit ?? null };
  });
}
