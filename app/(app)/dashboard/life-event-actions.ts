'use server';

// Server actions for Life-event playbooks (T9, M34). Launching a template no
// longer just writes a checklist: `lib/life-events/launch.ts` also creates the
// real to-dos and reminders through the domain services and hands moving,
// renovation and vacation off to the modules that own them. Failed launches
// undo their writes and report any incomplete cleanup. This file stays:
// auth, scope, and translating a service failure into copy. Family-scoped: RLS
// (is_family_member) guarantees a caller only ever touches their own family.
import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { launchLifeEvent, LIFE_EVENT_ROLLBACK_INCOMPLETE, type LifeEventHandoff } from '@/lib/life-events/launch';
import { getTemplate } from '@/lib/life-events/templates';
import { scopeFromUserContext } from '@/lib/services/scope';

type LaunchResult = {
  ok: boolean;
  planId?: string;
  /** What the launch actually created, so the UI can say it without inventing it. */
  created?: { items: number; todos: number; reminders: number; handoff: LifeEventHandoff | null };
  error?: string;
};
type Result = { ok: boolean; error?: string };

/** Start a life-event template on a chosen date: the plan, its dated checklist,
 *  the to-dos and reminders it implies, and the handoff to the module that owns
 *  the transition. `eventDate` is YYYY-MM-DD; when omitted, defaults to the
 *  template's lead time from today. Failed cleanup is explicitly reported. */
export async function launchLifeEventAction(templateKey: string, eventDate?: string | null): Promise<LaunchResult> {
  const t = await getTranslations();
  if (!getTemplate(templateKey)) return { ok: false, error: t('lifeEventActions.unknownLifeEvent') };

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);

  const launched = await launchLifeEvent(scope, { templateKey, eventDate: eventDate ?? null });
  if (!launched.ok) return {
    ok: false,
    error: launched.code === LIFE_EVENT_ROLLBACK_INCOMPLETE ? t('lifeEventActions.rollbackIncomplete') : launched.error,
  };
  return {
    ok: true,
    planId: launched.data.planId,
    created: {
      items: launched.data.itemCount,
      todos: launched.data.todoIds.length,
      reminders: launched.data.reminderIds.length,
      handoff: launched.data.handoff,
    },
  };
}

/** Set a plan's status (complete / archive / reactivate). */
export async function setLifeEventStatusAction(planId: string, status: 'active' | 'completed' | 'archived'): Promise<Result> {
  const t = await getTranslations();
  if (!planId) return { ok: false, error: t('lifeEventActions.invalidPlan') };
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
