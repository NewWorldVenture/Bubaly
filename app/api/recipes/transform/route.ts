import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { resolveProvider } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { buildTransformPrompt, parseTransformResult, getRecipeAiAction, type RecipeAiActionId } from '@/lib/recipes/ai-actions';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import type { Database } from '@/lib/database.types';

export const runtime = 'nodejs';
type Json = Database['public']['Tables']['family_recipes']['Insert']['ingredients'];

// AI recipe transform: produces a new vault recipe variant (healthier, cheaper,
// gluten-free, etc.) from a saved recipe. Server-side AI via the configured
// engine; rate-limited; nutrition/health disclaimers baked into the result.
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: t('transform.unauthorized') }, { status: 401 }); }

  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-recipe-transform:${ctx.user.id}`, { limit: 12 });
  if (!limited.ok) return NextResponse.json(
    { error: t('transform.tooManyRecipeTransformationsPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: t('transform.requestBodyIsTooLarge') }, { status: 400 });
  const { recipeId, actionId } = (boundedBody.value ?? {}) as { recipeId?: string; actionId?: string };
  if (!recipeId || !actionId || !getRecipeAiAction(actionId)) {
    return NextResponse.json({ error: t('transform.recipeidAndAValidActionid') }, { status: 422 });
  }

  const { data: recipe } = await supabase
    .from('family_recipes')
    .select('id, family_id, name, cuisine, servings, ingredients, instructions, allergy_flags, category, photo_url')
    .eq('id', recipeId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();
  if (!recipe) return NextResponse.json({ error: t('transform.recipeNotFound') }, { status: 404 });

  const prompt = buildTransformPrompt({
    name: recipe.name, cuisine: recipe.cuisine, servings: recipe.servings,
    ingredients: (recipe.ingredients as unknown as { name: string; quantity?: string; unit?: string }[]) ?? [],
    instructions: (recipe.instructions as unknown as { step: number; text: string }[]) ?? [],
    allergyFlags: recipe.allergy_flags ?? [],
  }, actionId as RecipeAiActionId);
  if (!prompt) return NextResponse.json({ error: t('transform.unknownAction') }, { status: 422 });

  let result;
  try {
    // The parse belongs inside: a model that answers in prose costs the same
    // tokens and leaves the cook with the same "please try again", but outside
    // the wrapper the row would read `completed`.
    result = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: `recipes.${actionId}`, text: 'Transform a recipe' },
      async (obs) => {
        const provider = await resolveProvider();
        const completion = await provider.complete({ system: prompt.system, messages: [{ role: 'user', content: prompt.user }], tools: [], maxTokens: 1800 });
        obs.used(completion.model ?? 'unknown', completion.usage);
        const parsed = parseTransformResult(completion.text, actionId as RecipeAiActionId);
        if (!parsed) obs.failed(new Error('The recipe variant did not parse.'));
        return parsed;
      },
    );
  } catch (err) {
    console.error('Recipe transform error:', err);
    return NextResponse.json({ error: t('transform.aiIsTemporarilyUnavailable') }, { status: 502 });
  }
  if (!result) return NextResponse.json({ error: t('transform.couldNotGenerateAVariant') }, { status: 502 });

  const action = getRecipeAiAction(actionId)!;
  const { data: saved, error } = await supabase
    .from('family_recipes')
    .insert({
      family_id: ctx.active.familyId,
      created_by: ctx.user.id,
      name: result.name,
      description: result.description,
      category: recipe.category,
      cuisine: recipe.cuisine,
      photo_url: recipe.photo_url,
      ingredients: result.ingredients as unknown as Json,
      instructions: result.instructions as unknown as Json,
      notes: result.notes,
      tags: [...new Set([...result.tags, `ai:${action.id}`])],
      ai_generated: true,
      source_provider: 'bubaly_ai',
      source_recipe_id: recipe.id,
      attribution: `AI variant (${action.label}) of "${recipe.name}"`,
    })
    .select('id')
    .single();
  if (error || !saved) {
    console.error('Recipe variant save failed:', error);
    return NextResponse.json({ error: t('transform.couldNotSaveVariant') }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: saved.id });
}
