'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { getProvider } from '@/lib/recipes/providers';
import type { Database } from '@/lib/database.types';

type Json = Database['public']['Tables']['family_recipes']['Insert']['ingredients'];
type SaveResult = { ok: true; id: string; already?: boolean } | { ok: false; error: string };

/**
 * Save a discovered recipe into the family vault. Re-fetches the full recipe
 * from the provider server-side (so the search payload can't be tampered with),
 * copies it locally with full source attribution + raw payload, and dedupes by
 * (family, provider, source id) so it survives provider outages thereafter.
 */
export async function saveDiscoveredRecipe(input: { provider: string; sourceRecipeId: string }): Promise<SaveResult> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;

  const provider = getProvider(input.provider);
  if (!provider?.lookup) return { ok: false, error: 'That recipe source is unavailable.' };

  const recipe = await provider.lookup(input.sourceRecipeId).catch(() => null);
  if (!recipe) return { ok: false, error: 'Could not load that recipe.' };

  const supabase = await createServer();

  // Already in the vault? Return it instead of duplicating.
  const { data: existing } = await supabase
    .from('family_recipes')
    .select('id')
    .eq('family_id', familyId)
    .eq('source_provider', recipe.sourceProvider)
    .eq('source_recipe_id', recipe.sourceRecipeId)
    .maybeSingle();
  if (existing) return { ok: true, id: existing.id, already: true };

  const { data, error } = await supabase
    .from('family_recipes')
    .insert({
      family_id: familyId,
      created_by: ctx.user.id,
      name: recipe.name,
      description: recipe.description,
      category: recipe.category,
      cuisine: recipe.cuisine,
      photo_url: recipe.photoUrl,
      tags: recipe.tags,
      ingredients: recipe.ingredients as unknown as Json,
      instructions: recipe.instructions as unknown as Json,
      source_url: recipe.sourceUrl,
      source_provider: recipe.sourceProvider,
      source_recipe_id: recipe.sourceRecipeId,
      attribution: recipe.attribution,
      license_notes: recipe.licenseNotes,
      imported_at: new Date().toISOString(),
      raw_payload: recipe.raw as unknown as Json,
    })
    .select('id')
    .single();

  if (error || !data) return { ok: false, error: error?.message ?? 'Could not save recipe.' };
  revalidatePath('/dashboard/recipes');
  return { ok: true, id: data.id };
}
