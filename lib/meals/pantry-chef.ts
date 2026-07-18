// lib/meals/pantry-chef.ts — the "Fridge Chef" engine.
// Pure, dependency-free logic behind /api/ai/pantry-chef: build the vision
// prompt (allergy-aware), parse the model's recipe JSON robustly, and flag any
// suggestion that conflicts with a family allergy (defense-in-depth in case the
// model slips). Kept side-effect-free so it unit-tests without a network/DB.

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

/** Vision prompt: identify what's in the photo and propose allergy-safe dinners. */
export function buildPantryChefPrompt(allergies: string[], now: Date = new Date()): string {
  const today = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
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
