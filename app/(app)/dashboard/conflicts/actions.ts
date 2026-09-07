'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

/**
 * Apply a conflict resolution by rescheduling one event. Family-scoped: RLS plus
 * an explicit family_id match ensure a user can only move their own family's
 * events. Returns ok/error so the client can show honest feedback.
 */
export async function rescheduleEventAction(
  eventId: string,
  startsAtIso: string,
  endsAtIso: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!eventId || Number.isNaN(new Date(startsAtIso).getTime())) {
    return { ok: false, error: t('actions.invalidRescheduleRequest') };
  }
  const supabase = await createServer();
  const { error } = await supabase
    .from('calendar_events')
    .update({ starts_at: startsAtIso, ends_at: endsAtIso })
    .eq('id', eventId)
    .eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/dashboard/conflicts');
  revalidatePath('/dashboard/command-center');
  revalidatePath('/dashboard/calendar');
  return { ok: true };
}
