'use server';

// Server actions for the Moments organizing layer (R12). Dismissing a moment keeps
// it quiet for the rest of the day; engaging one records the family acted on it
// (a signal the reasoning layer can learn from). Family-scoped via RLS.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

type Result = { ok: boolean; error?: string };

async function setMomentStatus(momentKey: string, status: 'engaged' | 'dismissed'): Promise<Result> {
  if (!momentKey) return { ok: false, error: 'Invalid moment' };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const today = new Date().toISOString().slice(0, 10);
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
