'use server';

// Server actions for the "insight of the day" (T4). Dismissing the surfaced
// insight marks its daily_insights row dismissed so the NEXT-best insight takes
// its place; acting on it (following the CTA) can mark it acted for the engagement
// signal. Family-scoped: RLS (is_family_member) guarantees a caller can only touch
// their own family's insights.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

type Result = { ok: boolean; error?: string };

async function setInsightStatus(id: string, status: 'dismissed' | 'acted'): Promise<Result> {
  const t = await getTranslations();
  if (!id || typeof id !== 'string') return { ok: false, error: t('insightActions.invalidInsight') };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase
    .from('daily_insights')
    .update({ status })
    .eq('id', id)
    .eq('family_id', ctx.active.familyId); // RLS also enforces this; explicit for clarity
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dashboard');
  return { ok: true };
}

/** Dismiss the insight of the day — the next-best insight surfaces on refresh. */
export async function dismissInsightAction(id: string): Promise<Result> {
  return setInsightStatus(id, 'dismissed');
}

/** Mark the insight acted on (engagement signal); also clears it from the home. */
export async function actOnInsightAction(id: string): Promise<Result> {
  return setInsightStatus(id, 'acted');
}
