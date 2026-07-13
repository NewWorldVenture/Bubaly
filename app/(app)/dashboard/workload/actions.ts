'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';

type Result = { ok: true } | { ok: false; error: string };

/**
 * Apply a rebalance suggestion: move an open chore assignment to another
 * member. RLS keeps it family-scoped; we also re-check the assignment is
 * still open so a stale suggestion can't clobber completed work.
 */
export async function moveAssignmentAction(assignmentId: string, toMemberId: string): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data: target } = await supabase.from('family_members')
    .select('id').eq('id', toMemberId).eq('family_id', ctx.active.familyId).maybeSingle();
  if (!target) return { ok: false, error: 'That family member was not found.' };

  const { error, count } = await supabase.from('chore_assignments')
    .update({ member_id: toMemberId }, { count: 'exact' })
    .eq('id', assignmentId)
    .eq('family_id', ctx.active.familyId)
    .in('status', ['todo', 'in_progress']);
  if (error) return { ok: false, error: error.message };
  if (!count) return { ok: false, error: 'That chore is no longer open — refresh and try again.' };

  await logAudit(supabase, {
    familyId: ctx.active.familyId, actorId: ctx.user.id, action: 'update',
    resource: 'chore_assignments', resourceId: assignmentId,
    metadata: { rebalance: true, toMemberId },
  });
  return { ok: true };
}

/**
 * Persist this week's computed loads as snapshots (upsert on member+week) so
 * the analytics trend survives source-row churn. Called from the module after
 * it computes the live report. Degrades safely before migration 0174.
 */
export async function saveWorkloadSnapshotAction(rows: {
  memberId: string; weekStart: string; choreMinutes: number; choreCount: number;
  taskCount: number; eventCount: number; loadScore: number; sharePct: number;
}[]): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  if (!rows.length) return { ok: true };

  try {
    const { error } = await supabase.from('workload_snapshots').upsert(
      rows.slice(0, 30).map(r => ({
        family_id: ctx.active.familyId,
        member_id: r.memberId,
        week_start: r.weekStart,
        chore_minutes: Math.max(0, Math.round(r.choreMinutes)),
        chore_count: Math.max(0, Math.round(r.choreCount)),
        task_count: Math.max(0, Math.round(r.taskCount)),
        event_count: Math.max(0, Math.round(r.eventCount)),
        load_score: Math.max(0, Math.min(100, Math.round(r.loadScore))),
        share_pct: Math.max(0, Math.min(100, r.sharePct)),
      })),
      { onConflict: 'family_id,member_id,week_start' },
    );
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Workload history is not available yet.' };
  }
}
