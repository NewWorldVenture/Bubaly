'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import { LADDER } from '@/lib/independence/progression';
import { wroteNoRows } from '@/lib/supabase/errors';

type Result = { ok: true } | { ok: false; error: string };

/** Add a ladder milestone to a child's track (status 'in_progress'). */
export async function startMilestoneAction(memberId: string, title: string): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const m = LADDER.find(l => l.title === title);
  if (!m) return { ok: false, error: t('actions.unknownMilestone') };

  const { error } = await supabase.from('independence_milestones').upsert({
    family_id: ctx.active.familyId,
    member_id: memberId,
    domain: m.domain,
    title: m.title,
    description: m.description,
    age_band: m.ageBand,
    status: 'in_progress',
    points: m.points,
    created_by: ctx.user.id,
  }, { onConflict: 'family_id,member_id,domain,title' });
  if (error) return { ok: false, error: error.message };

  await logAudit(supabase, {
    familyId: ctx.active.familyId, actorId: ctx.user.id, action: 'create',
    resource: 'independence_milestones', resourceId: memberId, metadata: { title },
  });
  return { ok: true };
}

/** Mark a milestone achieved (with optional evidence note). */
export async function achieveMilestoneAction(id: string, evidence?: string): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // `independence-module.tsx` toasts "<child> achieved “<title>” 🎉" on ok and
  // then calls `router.refresh()`. So an update that matched nothing put a
  // celebration on screen beside a milestone that stayed in progress — and this
  // is a recognition feature, where the message IS the product. Audit C1-S9-47.
  const { data: achieved, error } = await supabase.from('independence_milestones')
    .update({ status: 'achieved', achieved_at: new Date().toISOString(), evidence: evidence?.trim() || null })
    .eq('id', id).eq('family_id', ctx.active.familyId).select('id');
  if (error) return { ok: false, error: error.message };
  if (wroteNoRows(achieved)) return { ok: false, error: t('actions.couldNotUpdateThatMilestone') };
  return { ok: true };
}

/** Skip a milestone that doesn't fit this child/family. */
export async function skipMilestoneAction(id: string): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // Skipping promises the rung "won't be suggested again" — the module says so
  // in its toast. A silent no-op means it comes back.
  const { data: skipped, error } = await supabase.from('independence_milestones')
    .update({ status: 'skipped' }).eq('id', id).eq('family_id', ctx.active.familyId).select('id');
  if (error) return { ok: false, error: error.message };
  if (wroteNoRows(skipped)) return { ok: false, error: t('actions.couldNotUpdateThatMilestone') };
  return { ok: true };
}
