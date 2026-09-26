'use server';

// Server actions for the Moments organizing layer (R12). Dismissing a moment keeps
// it quiet for the rest of the day; engaging one records the family acted on it
// (a signal the reasoning layer can learn from). Family-scoped via RLS.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { dayKeyInTz } from '@/lib/services/scope';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

type Result = { ok: boolean; error?: string };

async function setMomentStatus(momentKey: string, status: 'engaged' | 'dismissed'): Promise<Result> {
  const t = await getTranslations();
  if (!momentKey) return { ok: false, error: t('actions.invalidMoment') };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // `as_of_date` is a DATE column and one third of this table's unique key
  // (0148: unique (family_id, moment_key, as_of_date)), and the ONLY reader of
  // it — app/(app)/dashboard/moments/page.tsx — asks for
  // `dayKeyInTz(now, family.timezone)`. A Greenwich key here
  // (`new Date().toISOString().slice(0, 10)`) therefore filed the dismissal
  // under a day the page never asks about: tomorrow's slot for a family west of
  // UTC in the evening (so the card came straight back, and was then wrongly
  // silent all of the next local day, because page.tsx's own log-back upsert
  // passes `ignoreDuplicates` and cannot overwrite the stranded row), and
  // yesterday's slot for a family east of UTC before dawn (so the dismissal was
  // discarded outright, with `{ ok: true }` and no toast). Resolve the day in
  // the family's zone with the SAME helper the reader uses, so the write key and
  // the read key cannot drift apart.
  const today = dayKeyInTz(new Date(), ctx.active.family.timezone || 'UTC');
  const { error } = await supabase.from('moment_activations').upsert(
    { family_id: ctx.active.familyId, moment_key: momentKey, as_of_date: today, status, created_by: ctx.user.id },
    { onConflict: 'family_id,moment_key,as_of_date' },
  );
  if (error) return { ok: false, error: error.message };
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
