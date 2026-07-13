import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { resolveProvider } from '@/lib/ai/provider';
import { buildTransformPrompt, parseTransformResult, getRecipeAiAction, type RecipeAiActionId } from '@/lib/recipes/ai-actions';
import type { Database } from '@/lib/database.types';

export const runtime = 'nodejs';
type Json = Database['public']['Tables']['family_recipes']['Insert']['ingredients'];

// AI recipe transform: produces a new vault recipe variant (healthier, cheaper,
// gluten-free, etc.) from a saved recipe. Server-side AI via the configured
// engine; rate-limited; nutrition/health disclaimers baked into the result.
export async function POST(req: NextRequest) {
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const supabase = await createServer();
  const limited = await enforceAIRateLimit(supabase, `ai-recipe-transform:${ctx.user.id}`, { limit: 12 });
  if (!limited.ok) return NextResponse.json(
    { error: 'Too many recipe transformations. Please try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const { recipeId, actionId } = await req.json().catch(() => ({})) as { recipeId?: string; actionId?: string };
  if (!recipeId || !actionId || !getRecipeAiAction(actionId)) {
    return NextResponse.json({ error: 'recipeId and a valid actionId are required' }, { status: 422 });
  }

  const { data: recipe } = await supabase
    .from('family_recipes')
    .select('id, family_id, name, cuisine, servings, ingredients, instructions, allergy_flags, category, photo_url')
    .eq('id', recipeId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();
  if (!recipe) return NextResponse.json({ error: 'Recipe not found' }, { status: 404 });

  const prompt = buildTransformPrompt({
    name: recipe.name, cuisine: recipe.cuisine, servings: recipe.servings,
    ingredients: (recipe.ingredients as unknown as { name: string; quantity?: string; unit?: string }[]) ?? [],
    instructions: (recipe.instructions as unknown as { step: number; text: string }[]) ?? [],
    allergyFlags: recipe.allergy_flags ?? [],
  }, actionId as RecipeAiActionId);
  if (!prompt) return NextResponse.json({ error: 'Unknown action' }, { status: 422 });

  let result;
  try {
    const provider = await resolveProvider();
    const completion = await provider.complete({ system: prompt.system, messages: [{ role: 'user', content: prompt.user }], tools: [], maxTokens: 1800 });
    result = parseTransformResult(completion.text, actionId as RecipeAiActionId);
  } catch (err) {
    console.error('Recipe transform error:', err);
    return NextResponse.json({ error: 'AI is temporarily unavailable.' }, { status: 502 });
  }
  if (!result) return NextResponse.json({ error: 'Could not generate a variant — please try again.' }, { status: 502 });

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
  if (error || !saved) return NextResponse.json({ error: error?.message ?? 'Could not save variant' }, { status: 500 });

  return NextResponse.json({ ok: true, id: saved.id });
}
