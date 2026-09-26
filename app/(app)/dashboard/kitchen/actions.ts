'use server';

// Smart Kitchen server actions — leftover logging (the waste-cutting
// differentiator) + Family Food Health Score snapshots. Family-scoped via RLS.

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeDbError } from '@/lib/supabase/errors';
import { todayInZone } from '@/lib/schedule/zoned';
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

  // The day on the family's kitchen wall, not Greenwich's. This read
  // `new Date().toISOString().slice(0, 10)`, which answers the UTC day, so from
  // 17:00 local in Los Angeles (and before 10:00 in Sydney, with the sign
  // reversed) the snapshot landed on a NEIGHBOURING day's key. Because the write
  // below is an upsert on UNIQUE (family_id, snapshot_date)
  // (0102_food_os.sql:57), that misdated row occupied the neighbour's slot and
  // the next save on that day silently overwrote it: two calendar days of a
  // once-a-day history collapsed into one row, and the UI reported both saves as
  // saved. The page that COMPUTES this score resolves the same zone with the same
  // `|| 'UTC'` (kitchen/page.tsx:30-31), through `dayKeyInTz` rather than
  // `todayInZone`; both are the same en-CA Intl day with the same UTC-slice
  // fallback (scope.ts dayKeyInTz, zoned.ts dayKeyInZone), so the day the score
  // was computed for and the day it is filed on compare equal.
  const today = todayInZone(ctx.active.family.timezone || 'UTC');
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
