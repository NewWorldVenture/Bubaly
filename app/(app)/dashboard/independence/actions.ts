'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import { LADDER } from '@/lib/independence/progression';
import { describeActionError } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';

type Result = { ok: true } | { ok: false; error: string };

// The ladder is a parent's to move (0338): a child reads their own progress but
// does not mark it achieved, skip what they would rather not do, or edit a
// sibling's track. Checked here so a child gets a sentence rather than a
// database refusal; the database is what actually holds the line.
//
// RLS FILTERS an update rather than refusing it, so the two updates below read
// the row back — `error: null` over zero rows is a milestone that did not move.

/** Add a ladder milestone to a child's track (status 'in_progress'). */
export async function startMilestoneAction(memberId: string, title: string): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentCanMoveTheLadder') };
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
  if (error) return { ok: false, error: describeActionError(error) };

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
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentCanMoveTheLadder') };
  const supabase = await createServer();
  const { data, error } = await supabase.from('independence_milestones')
    .update({ status: 'achieved', achieved_at: new Date().toISOString(), evidence: evidence?.trim() || null })
    .eq('id', id).eq('family_id', ctx.active.familyId)
    .select('id');
  if (error) return { ok: false, error: describeActionError(error) };
  if (!data || data.length === 0) return { ok: false, error: t('actions.onlyAParentCanMoveTheLadder') };
  return { ok: true };
}

/** Skip a milestone that doesn't fit this child/family. */
export async function skipMilestoneAction(id: string): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentCanMoveTheLadder') };
  const supabase = await createServer();
  const { data, error } = await supabase.from('independence_milestones')
    .update({ status: 'skipped' }).eq('id', id).eq('family_id', ctx.active.familyId)
    .select('id');
  if (error) return { ok: false, error: describeActionError(error) };
  if (!data || data.length === 0) return { ok: false, error: t('actions.onlyAParentCanMoveTheLadder') };
  return { ok: true };
}
