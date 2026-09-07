'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import { LADDER } from '@/lib/independence/progression';

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
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('independence_milestones')
    .update({ status: 'achieved', achieved_at: new Date().toISOString(), evidence: evidence?.trim() || null })
    .eq('id', id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Skip a milestone that doesn't fit this child/family. */
export async function skipMilestoneAction(id: string): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('independence_milestones')
    .update({ status: 'skipped' }).eq('id', id).eq('family_id', ctx.active.familyId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
