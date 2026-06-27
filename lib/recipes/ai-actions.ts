// AI recipe transform actions — pure prompt-building + result parsing.
// No network/deps so it's unit tested. The route calls resolveProvider() with
// the prompt and feeds the model output back through parseTransformResult().

export type RecipeAiActionId =
  | 'healthier' | 'cheaper' | 'higher_protein' | 'lower_sodium' | 'kid_friendly'
  | 'gluten_free' | 'dairy_free' | 'vegetarian' | 'vegan' | 'liver_friendly';

export const RECIPE_AI_ACTIONS: { id: RecipeAiActionId; label: string; instruction: string; health: boolean }[] = [
  { id: 'healthier', label: 'Make it healthier', instruction: 'Reduce added sugar, refined carbs, and unhealthy fats; add vegetables/fiber where natural. Keep it tasty and family-friendly.', health: true },
  { id: 'cheaper', label: 'Make it cheaper', instruction: 'Swap expensive ingredients for affordable, common ones; reduce waste; keep flavor.', health: false },
  { id: 'higher_protein', label: 'Higher protein', instruction: 'Increase protein per serving using realistic ingredient swaps/additions.', health: true },
  { id: 'lower_sodium', label: 'Lower sodium', instruction: 'Reduce salt and high-sodium ingredients; use herbs/spices/acids for flavor.', health: true },
  { id: 'kid_friendly', label: 'Kid-friendly', instruction: 'Make it appealing to kids: milder spice, familiar textures, fun presentation; keep it reasonably nutritious.', health: false },
  { id: 'gluten_free', label: 'Gluten-free', instruction: 'Replace all gluten-containing ingredients with gluten-free alternatives.', health: false },
  { id: 'dairy_free', label: 'Dairy-free', instruction: 'Replace all dairy with dairy-free alternatives.', health: false },
  { id: 'vegetarian', label: 'Vegetarian', instruction: 'Replace meat/fish with vegetarian alternatives while keeping protein and flavor.', health: false },
  { id: 'vegan', label: 'Vegan', instruction: 'Replace all animal products with plant-based alternatives.', health: false },
  { id: 'liver_friendly', label: 'Liver-friendly', instruction: 'Lower saturated fat, added sugar, salt, and alcohol; favor lean proteins, vegetables, whole grains.', health: true },
];

export function getRecipeAiAction(id: string) {
  return RECIPE_AI_ACTIONS.find((a) => a.id === id);
}

const DISCLAIMER = 'AI-generated variant — ingredient amounts and any nutrition figures are estimates, not exact values.';
const HEALTH_DISCLAIMER = 'This is general information for healthy cooking, not medical or dietary advice. For health conditions or allergies, consult a qualified professional.';

type RecipeLike = {
  name: string;
  cuisine?: string | null;
  servings?: number | null;
  ingredients: { name: string; quantity?: string; unit?: string }[];
  instructions: { step: number; text: string }[];
  allergyFlags?: string[];
};

export function buildTransformPrompt(recipe: RecipeLike, actionId: RecipeAiActionId): { system: string; user: string } | null {
  const action = getRecipeAiAction(actionId);
  if (!action) return null;

  const system = [
    'You are a careful family recipe assistant. Transform the given recipe per the instruction.',
    'Return ONLY valid JSON (no markdown, no prose). Start with { and end with }.',
    'Shape: {"name": string, "description": string, "ingredients": [{"name": string, "quantity": string, "unit": string}], "instructions": [{"step": number, "text": string}], "notes": string, "tags": [string]}.',
    'Keep amounts realistic. Do NOT claim the recipe treats, cures, or prevents any disease.',
    'Be conservative with allergies: if you cannot guarantee a swap is safe, say so in notes.',
  ].join('\n');

  const ing = recipe.ingredients.map((i) => `- ${[i.quantity, i.unit, i.name].filter(Boolean).join(' ')}`).join('\n');
  const steps = recipe.instructions.map((s) => `${s.step}. ${s.text}`).join('\n');
  const user = [
    `TRANSFORM: ${action.instruction}`,
    `Keep it the same dish family where possible. Put a one-line summary of changes at the start of "notes".`,
    recipe.allergyFlags?.length ? `Existing allergy flags: ${recipe.allergyFlags.join(', ')}.` : '',
    '',
    `RECIPE: ${recipe.name}${recipe.cuisine ? ` (${recipe.cuisine})` : ''}`,
    recipe.servings ? `Servings: ${recipe.servings}` : '',
    `Ingredients:\n${ing || '- (none listed)'}`,
    `Instructions:\n${steps || '(none listed)'}`,
  ].filter(Boolean).join('\n');

  return { system, user };
}

export type TransformedRecipe = {
  name: string;
  description: string | null;
  ingredients: { name: string; quantity: string; unit: string }[];
  instructions: { step: number; text: string }[];
  notes: string;
  tags: string[];
};

/** Parse model output into a vault-shaped recipe; appends required disclaimers. */
export function parseTransformResult(text: string, actionId: RecipeAiActionId): TransformedRecipe | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(match[0]); } catch { return null; }

  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : null;
  if (!name) return null;

  const ingredients = Array.isArray(obj.ingredients)
    ? obj.ingredients.map((x) => {
        const o = (x ?? {}) as Record<string, unknown>;
        return { name: String(o.name ?? '').trim(), quantity: String(o.quantity ?? '').trim(), unit: String(o.unit ?? '').trim() };
      }).filter((i) => i.name)
    : [];

  const instructions = Array.isArray(obj.instructions)
    ? obj.instructions.map((x, i) => {
        const o = (x ?? {}) as Record<string, unknown>;
        const t = typeof o === 'string' ? o : String(o.text ?? '').trim();
        return { step: Number(o.step) || i + 1, text: t };
      }).filter((s) => s.text)
    : [];

  const tags = Array.isArray(obj.tags) ? obj.tags.map((t) => String(t).trim()).filter(Boolean) : [];

  const action = getRecipeAiAction(actionId);
  const base = typeof obj.notes === 'string' ? obj.notes.trim() : '';
  const notes = [base, DISCLAIMER, action?.health ? HEALTH_DISCLAIMER : ''].filter(Boolean).join('\n\n');

  return { name, description: typeof obj.description === 'string' ? obj.description.trim() || null : null, ingredients, instructions, notes, tags };
}
