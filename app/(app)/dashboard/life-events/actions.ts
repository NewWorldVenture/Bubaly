'use server';

// Ticking a step of a playbook's checklist in Life & Milestones. The tick was a
// write straight from the browser, and life_event_plan_items asks only that the
// caller is a member of the family (0464's guest refusal does not cover it), so
// a guest ticked and unticked a parent's checklist (household-roles
// N4-R1-SIBLING). A guest views the household and does not plan in it, as
// launchLifeEventAction refuses one (app/(app)/dashboard/life-event-actions.ts).
import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';

type Result = { ok: boolean; error?: string };

/** Mark one step of the family's playbook done, or not done. */
export async function setLifeEventItemDoneAction(itemId: string, done: boolean): Promise<Result> {
  const t = await getTranslations();
  if (!itemId) return { ok: false, error: t('errors.thatChangeWasNotSaved') };
  const ctx = await requireUserContext();
  if (ctx.active.role === 'guest') return { ok: false, error: t('householdRoles.guestViewsOnly') };
  const supabase = await createServer();
  // Under RLS a refused row comes back with no error and zero rows, which the
  // module used to report as done. Audit C1-S9-86.
  const { data: ticked, error } = await supabase
    .from('life_event_plan_items')
    .update({ is_done: done })
    .eq('id', itemId)
    .eq('family_id', ctx.active.familyId)
    .select('id');
  if (error) return { ok: false, error: describeActionError(error, t('errors.thatChangeWasNotSaved')) };
  if (wroteNoRows(ticked)) return { ok: false, error: t('errors.thatChangeWasNotSaved') };
  return { ok: true };
}
