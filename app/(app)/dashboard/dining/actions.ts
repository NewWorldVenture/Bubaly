'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';

type Result = { ok: true } | { ok: false; error: string };

/** Heart / un-heart a saved restaurant. */
export async function toggleFavoriteAction(id: string, next: boolean): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('dining_out')
    .update({ is_favorite: next }).eq('id', id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Save a restaurant the family wants to try (or loves). */
export async function addRestaurantAction(input: {
  name: string; cuisine?: string; priceLevel?: number; rating?: number; distanceKm?: number;
}): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const name = (input.name ?? '').trim();
  if (name.length < 2) return { ok: false, error: t('actions.giveThePlaceAName') };
  const { error } = await supabase.from('dining_out').insert({
    family_id: ctx.active.familyId,
    name,
    kind: 'restaurant',
    cuisine: input.cuisine?.trim() || null,
    price_level: input.priceLevel && input.priceLevel >= 1 && input.priceLevel <= 4 ? input.priceLevel : null,
    rating: input.rating != null && input.rating >= 0 && input.rating <= 5 ? input.rating : null,
    distance_km: input.distanceKm ?? null,
    created_by: ctx.user.id,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Log a dining-out visit (what the history + spend stats are built from). */
export async function logVisitAction(input: {
  name: string; amountCents?: number; itemCount?: number; visitedAt?: string;
}): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const name = (input.name ?? '').trim();
  if (name.length < 2) return { ok: false, error: t('actions.whichRestaurantWasIt') };
  const { error } = await supabase.from('dining_out').insert({
    family_id: ctx.active.familyId,
    name,
    kind: 'visit',
    amount_cents: input.amountCents != null && input.amountCents >= 0 ? Math.round(input.amountCents) : null,
    item_count: input.itemCount != null && input.itemCount >= 0 ? Math.round(input.itemCount) : null,
    visited_at: input.visitedAt || new Date().toISOString(),
    created_by: ctx.user.id,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
