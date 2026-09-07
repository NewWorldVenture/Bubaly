'use server';

// Server actions for Family Intelligence — the hard signals (R10). Transparent +
// EDITABLE: the family can Refresh (recompute from live data), Acknowledge a signal
// (I've seen it), or Dismiss it (stop surfacing this pattern). Family-scoped via RLS.
import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { runSignalDetection } from '@/lib/intelligence/hard-signals-server';
import { describeActionError } from '@/lib/supabase/errors';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

/** Recompute the family's hard signals from live data. */
export async function refreshSignalsAction(): Promise<Result<{ signals: number }>> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const res = await runSignalDetection(supabase, ctx.active.familyId, new Date());
  if (!res.ok) return { ok: false, error: res.error ?? 'Could not refresh signals' };
  revalidatePath('/dashboard/family-signals');
  return { ok: true, data: { signals: res.signals } };
}

/** Acknowledge, dismiss, or restore a signal (the editable half). */
export async function setSignalStatusAction(id: string, status: 'active' | 'acknowledged' | 'dismissed'): Promise<Result> {
  const t = await getTranslations();
  if (!id) return { ok: false, error: t('actions.invalidSignal') };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('family_signals')
    .update({ status })
    .eq('id', id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: describeActionError(error, t('actions.couldNotUpdateThatSignal')) };
  revalidatePath('/dashboard/family-signals');
  return { ok: true };
}
