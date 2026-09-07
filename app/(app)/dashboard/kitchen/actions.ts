'use server';

// Smart Kitchen server actions — leftover logging (the waste-cutting
// differentiator) + Family Food Health Score snapshots. Family-scoped via RLS.

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeDbError } from '@/lib/supabase/errors';
import type { SubScore } from '@/lib/food/score';

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

const LOCATIONS = ['fridge', 'freezer', 'counter', 'other'] as const;
const STATUSES = ['fresh', 'eaten', 'frozen', 'tossed', 'donated'] as const;

export async function addLeftoverAction(input: {
  name: string;
  sourceMeal?: string | null;
  quantity?: string | null;
  useBy?: string | null;
  location?: string;
}): Promise<Result<{ id: string }>> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const name = input.name.trim();
  if (!name) return { ok: false, error: t('actions.giveTheLeftoverAName') };
  const location = LOCATIONS.includes((input.location ?? 'fridge') as never) ? input.location! : 'fridge';

  const { data, error } = await supabase
    .from('leftover_inventory')
    .insert({
      family_id: ctx.active.familyId,
      created_by: ctx.user.id,
      updated_by: ctx.user.id,
      name,
      source_meal: input.sourceMeal?.trim() || null,
      quantity: input.quantity?.trim() || null,
      use_by: input.useBy || null,
      location,
    })
    .select('id')
    .maybeSingle();

  if (error) return { ok: false, error: describeDbError(error) };
  revalidatePath('/dashboard/kitchen');
  return { ok: true, data: { id: data!.id } };
}

export async function updateLeftoverStatusAction(input: { id: string; status: string }): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  if (!STATUSES.includes(input.status as never)) return { ok: false, error: t('actions.invalidStatus') };

  const { error } = await supabase
    .from('leftover_inventory')
    .update({ status: input.status, updated_by: ctx.user.id })
    .eq('id', input.id).eq('family_id', ctx.active.familyId);

  if (error) return { ok: false, error: describeDbError(error) };
  revalidatePath('/dashboard/kitchen');
  return { ok: true };
}

export async function deleteLeftoverAction(input: { id: string }): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase
    .from('leftover_inventory').delete().eq('id', input.id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: describeDbError(error) };
  revalidatePath('/dashboard/kitchen');
  return { ok: true };
}

/** Snapshot today's Family Food Health Score (one row per family per day). */
export async function snapshotFoodScoreAction(input: {
  overall: number;
  grade: string;
  subScores: SubScore[];
  coaching: string[];
}): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase
    .from('family_food_scores')
    .upsert(
      {
        family_id: ctx.active.familyId,
        snapshot_date: today,
        overall: Math.max(0, Math.min(100, Math.round(input.overall))),
        grade: input.grade,
        sub_scores: input.subScores as never,
        coaching: input.coaching as never,
        created_by: ctx.user.id,
        updated_by: ctx.user.id,
      },
      { onConflict: 'family_id,snapshot_date' },
    );

  if (error) return { ok: false, error: describeDbError(error) };
  revalidatePath('/dashboard/kitchen');
  return { ok: true };
}
