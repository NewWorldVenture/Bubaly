'use server';

// Server actions for Life-event playbooks (T9). Launching a template creates the
// plan + its dated checklist in one server round-trip (so a half-created plan
// never appears), then archiving/completing flips status. Family-scoped: RLS
// (is_family_member) guarantees a caller only ever touches their own family.
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { getTemplate, buildPlanItems } from '@/lib/life-events/templates';

type LaunchResult = { ok: boolean; planId?: string; error?: string };
type Result = { ok: boolean; error?: string };

/** Start a life-event template on a chosen date: creates the plan and its dated
 *  items. `eventDate` is YYYY-MM-DD; when omitted, defaults to the template's
 *  lead time from today. */
export async function launchLifeEventAction(templateKey: string, eventDate?: string | null): Promise<LaunchResult> {
  const template = getTemplate(templateKey);
  if (!template) return { ok: false, error: 'Unknown life event' };

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  // Resolve the anchor date (validate the passed value; else default lead time).
  let anchor = typeof eventDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : null;
  if (!anchor) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + template.defaultLeadDays);
    anchor = d.toISOString().slice(0, 10);
  }

  const { data: plan, error: planErr } = await supabase
    .from('life_event_plans')
    .insert({ family_id: familyId, template_key: template.key, title: template.title, event_date: anchor, created_by: ctx.user.id })
    .select('id')
    .single();
  if (planErr || !plan) return { ok: false, error: planErr?.message ?? 'Could not start the plan' };

  const items = buildPlanItems(template, anchor).map((it) => ({
    family_id: familyId, plan_id: plan.id, title: it.title, category: it.category,
    due_on: it.due_on, sort: it.sort, note: it.note, created_by: ctx.user.id,
  }));
  const { error: itemsErr } = await supabase.from('life_event_plan_items').insert(items);
  if (itemsErr) {
    // Roll back the orphan plan so a failed launch leaves nothing behind.
    await supabase.from('life_event_plans').delete().eq('id', plan.id);
    return { ok: false, error: itemsErr.message };
  }
  return { ok: true, planId: plan.id };
}

/** Set a plan's status (complete / archive / reactivate). */
export async function setLifeEventStatusAction(planId: string, status: 'active' | 'completed' | 'archived'): Promise<Result> {
  if (!planId) return { ok: false, error: 'Invalid plan' };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase
    .from('life_event_plans')
    .update({ status })
    .eq('id', planId)
    .eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
