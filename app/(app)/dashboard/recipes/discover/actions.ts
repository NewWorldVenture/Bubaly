'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { getProvider } from '@/lib/recipes/providers';
import type { Database } from '@/lib/database.types';

type Json = Database['public']['Tables']['family_recipes']['Insert']['ingredients'];
type SaveResult = { ok: true; id: string; already?: boolean } | { ok: false; error: string };

// `family_recipes.category` is CHECK-constrained to exactly this set
// (supabase/migrations/0014_core_platform.sql). A provider speaks its own
// vocabulary — TheMealDB answers "Chicken", "Seafood", "Pasta", "Starter" — so
// inserting its word raw is rejected by Postgres and "Save to vault" fails for
// most of the library. Clamp to the allow-list the way createRecipe
// (lib/services/meals/index.ts) already does; the provider's own word is not
// lost, it stays verbatim in `raw_payload`.
const RECIPE_CATEGORIES = ['breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'drink', 'side', 'appetizer', 'other'];

/**
 * Save a discovered recipe into the family vault. Re-fetches the full recipe
 * from the provider server-side (so the search payload can't be tampered with),
 * copies it locally with full source attribution + raw payload, and dedupes by
 * (family, provider, source id) so it survives provider outages thereafter.
 */
export async function saveDiscoveredRecipe(input: { provider: string; sourceRecipeId: string }): Promise<SaveResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;

  const provider = getProvider(input.provider);
  if (!provider?.lookup) return { ok: false, error: t('actions.thatRecipeSourceIsUnavailable') };

  const recipe = await provider.lookup(input.sourceRecipeId).catch(() => null);
  if (!recipe) return { ok: false, error: t('actions.couldNotLoadThatRecipe') };

  const supabase = await createServer();

  // Already in the vault? Return it instead of duplicating.
  //
  // Asked in one place because it is asked twice: once before inserting, and
  // again if the insert loses the race 0349's unique index now decides.
  //
  // `.limit(1)` is load-bearing, not decoration. postgrest-js turns
  // `maybeSingle()` on more than one matching row into PGRST116/406 with
  // `data: null` — the same value the query returns for "not in the vault" — so
  // once a family carried one duplicate pair the probe errored for ever. Asking
  // the question the probe actually means ("is there at least one?") makes that
  // family's answer "already saved" instead of a wall. Every sibling probe does
  // the same (lib/services/meals/index.ts, lib/services/idempotency.ts).
  const probeVault = () =>
    supabase
      .from('family_recipes')
      .select('id')
      .eq('family_id', familyId)
      .eq('source_provider', recipe.sourceProvider)
      .eq('source_recipe_id', recipe.sourceRecipeId)
      .limit(1)
      .maybeSingle();

  const { data: existing, error: probeError } = await probeVault();
  // The house rule, written out at lib/services/idempotency.ts: a probe that
  // fails is fatal, never a fall-through to `insert`. The error used not to be
  // bound at all, so a failed lookup read as "not saved yet": the action
  // inserted a second copy and the client toasted "Saved to your family vault".
  // A duplicate the family then has to hunt down is worse than an honest "try
  // again", and the caller already knows how to retry.
  if (probeError) {
    console.error('[recipes/discover] vault duplicate probe failed', probeError);
    return { ok: false, error: t('actions.couldNotCheckYourRecipeVault') };
  }
  if (existing) return { ok: true, id: existing.id, already: true };

  const { data, error } = await supabase
    .from('family_recipes')
    .insert({
      family_id: familyId,
      created_by: ctx.user.id,
      name: recipe.name,
      description: recipe.description,
      category: RECIPE_CATEGORIES.includes(recipe.category) ? recipe.category : 'dinner',
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

  if (error || !data) {
    // The probe said no and the insert still collided: on a table carrying
    // 0349's partial unique index that is exactly what losing a concurrent
    // "Save to vault" looks like, and the row the winner wrote is the honest
    // answer. A 23505 with nothing behind it is returned unchanged, so a real
    // failure is never dressed up as a success — the same shape
    // lib/services/idempotency.ts uses for 0256's keyed tables.
    if (error?.code === '23505') {
      const { data: raced, error: racedError } = await probeVault();
      if (!racedError && raced) return { ok: true, id: raced.id, already: true };
    }
    return { ok: false, error: error?.message ?? 'Could not save recipe.' };
  }
  revalidatePath('/dashboard/recipes');
  return { ok: true, id: data.id };
}
