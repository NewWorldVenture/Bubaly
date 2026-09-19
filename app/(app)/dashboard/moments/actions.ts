'use server';

// Server actions for the Moments organizing layer (R12). Dismissing a moment keeps
// it quiet for the rest of the day; engaging one records the family acted on it
// (a signal the reasoning layer can learn from). Family-scoped via RLS.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { todayKeyFor } from '@/lib/services/scope';
import { createServer } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: boolean; error?: string };

async function setMomentStatus(momentKey: string, status: 'engaged' | 'dismissed'): Promise<Result> {
  const t = await getTranslations();
  if (!momentKey) return { ok: false, error: t('actions.invalidMoment') };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // "Hide a moment for the rest of today" is what the caller's own comment
  // says, and `as_of_date` under the host's day wrote TOMORROW's row: the
  // moment stayed on screen for the rest of the evening and arrived already
  // dismissed the next morning.
  const today = todayKeyFor(ctx);
  const { error } = await supabase.from('moment_activations').upsert(
    { family_id: ctx.active.familyId, moment_key: momentKey, as_of_date: today, status, created_by: ctx.user.id },
    { onConflict: 'family_id,moment_key,as_of_date' },
  );
  if (error) return { ok: false, error: describeActionError(error) };
  revalidatePath('/dashboard/moments');
  return { ok: true };
}

/** Hide a moment for the rest of today. */
export async function dismissMomentAction(momentKey: string): Promise<Result> {
  return setMomentStatus(momentKey, 'dismissed');
}

/** Record that the family acted on a moment (engagement signal). */
export async function engageMomentAction(momentKey: string): Promise<Result> {
  return setMomentStatus(momentKey, 'engaged');
}
