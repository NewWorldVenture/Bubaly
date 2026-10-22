'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { settleAll } from '@/lib/supabase/settle';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { computeWorkload, isoWeekStart } from '@/lib/workload/balance';
import { addDaysToDayKey, dayKeyInTz } from '@/lib/services/scope';
import { wallFromKey, wallToInstant } from '@/lib/time/wall-clock';

type Result = { ok: true } | { ok: false; error: string };

/**
 * Apply a rebalance suggestion: move an open chore assignment to another
 * member. RLS keeps it family-scoped; we also re-check the assignment is
 * still open so a stale suggestion can't clobber completed work.
 */
export async function moveAssignmentAction(assignmentId: string, toMemberId: string): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  // Rebalancing moves a chore - and the points it will earn - between
  // members: a manager's call (0374 holds RLS to the same).
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.thatChoreIsNoLonger') };
  const supabase = await createServer();

  const { data: target, error: targetReadError } = await supabase.from('family_members')
    .select('id').eq('id', toMemberId).eq('family_id', ctx.active.familyId).maybeSingle();
  // A refused read is not an absence: it used to return the "not found" answer below. Audit C1-S9-75.
  if (targetReadError) return { ok: false, error: describeActionError(targetReadError, t('actions.couldNotCheckThatRefresh')) };
  if (!target) return { ok: false, error: t('actions.thatFamilyMemberWasNot') };

  // Confirmed by reading back the rows the filter matched: under RLS a row the
  // caller may not move is filtered, not refused, and answers no error and zero
  // rows. This used to confirm by `count: 'exact'`, which says the same thing
  // by the other route; `.select('id')` is the house shape the gated-write guard
  // (tests/a-filtered-delete-is-not-a-deletion.test.ts) recognises, so the site
  // no longer needs a line in its tolerated list. Audit C1-S9-59.
  const { data: moved, error } = await supabase.from('chore_assignments')
    .update({ member_id: toMemberId })
    .eq('id', assignmentId)
    .eq('family_id', ctx.active.familyId)
    .in('status', ['todo', 'in_progress'])
    .select('id');
  if (error) return { ok: false, error: describeActionError(error) };
  if (wroteNoRows(moved)) return { ok: false, error: t('actions.thatChoreIsNoLonger') };

  await logAudit(supabase, {
    familyId: ctx.active.familyId, actorId: ctx.user.id, action: 'update',
    resource: 'chore_assignments', resourceId: assignmentId,
    metadata: { rebalance: true, toMemberId },
  });
  return { ok: true };
}

/** More rows of one kind than a household makes in a week; a read past it fails rather than counting a prefix. */
const WEEK_READ_MAX = 50_000;

type IdRow = { id: string } & Record<string, unknown>;

/**
 * One ISO week's loads — Monday 00:00 to the next Monday 00:00 on the family's
 * clock — computed here, from that week's own rows, with the engine the page
 * uses. Read whole and in id order: these rows are counted into a share.
 */
async function weekLoads(supabase: Awaited<ReturnType<typeof createServer>>, familyId: string, fromIso: string, toIso: string) {
  const byId = <T extends IdRow>(page: (after: string | null, limit: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) =>
    readAllByIdAsQuery<T>(page, { max: WEEK_READ_MAX });
  const [members, assignments, todos, events] = await settleAll([
    supabase.from('family_members').select('id, display_name, role, user_id').eq('family_id', familyId).eq('is_active', true),
    byId((after, limit) => {
      let q = supabase.from('chore_assignments').select('id, chore_id, member_id, status')
        .eq('family_id', familyId).gte('created_at', fromIso).lt('created_at', toIso);
      if (after) q = q.gt('id', after);
      return q.order('id').limit(limit);
    }),
    byId((after, limit) => {
      let q = supabase.from('todo_items').select('id, assigned_to_id, is_done')
        .eq('family_id', familyId).gte('created_at', fromIso).lt('created_at', toIso);
      if (after) q = q.gt('id', after);
      return q.order('id').limit(limit);
    }),
    byId((after, limit) => {
      let q = supabase.from('calendar_events').select('id, created_by')
        .eq('family_id', familyId).gte('starts_at', fromIso).lt('starts_at', toIso);
      if (after) q = q.gt('id', after);
      return q.order('id').limit(limit);
    }),
  ]);
  const failed = [members, assignments, todos, events].find((read) => read.error);
  if (failed) return { error: failed.error };
  const asg = (assignments.data ?? []) as { id: string; chore_id: string; member_id: string; status: string }[];
  const choreIds = [...new Set(asg.map((a) => a.chore_id))];
  const chores = choreIds.length
    ? await supabase.from('chores').select('id, title, est_minutes, points').eq('family_id', familyId).in('id', choreIds)
    : { data: [] as { id: string; title: string; est_minutes: number | null; points: number }[], error: null };
  if (chores.error) return { error: chores.error };
  const choreById = new Map((chores.data ?? []).map((c) => [c.id, c]));
  const roster = (members.data ?? []) as { id: string; display_name: string; role: string; user_id: string | null }[];
  const memberByUser = new Map(roster.filter((m) => m.user_id).map((m) => [m.user_id as string, m.id]));
  const report = computeWorkload(
    roster.map((m) => ({ id: m.id, name: m.display_name, role: m.role })),
    asg.map((a) => {
      const c = choreById.get(a.chore_id);
      return {
        id: a.id, choreId: a.chore_id, memberId: a.member_id, status: a.status,
        choreTitle: c?.title ?? 'Chore', estMinutes: c?.est_minutes ?? null, points: c?.points ?? 10,
      };
    }),
    ((todos.data ?? []) as { assigned_to_id: string | null; is_done: boolean }[]).map((t) => ({ assignedToId: t.assigned_to_id, isDone: t.is_done })),
    ((events.data ?? []) as { created_by: string | null }[]).map((e) => ({ createdBy: e.created_by ? memberByUser.get(e.created_by) ?? null : null })),
  );
  return { report };
}

/**
 * Persist THIS ISO week's loads as snapshots (upsert on member+week) so the
 * analytics trend survives source-row churn.
 *
 * The browser used to hand in the report it had computed for the page — the
 * ROLLING seven days before the view, with every future event in it — and it
 * was filed under this ISO week's Monday on every view, by anyone. A view on
 * Monday at 08:00 wrote last week's work into this week's row, and the trend
 * ("carried N% for 6 straight weeks") was shifted by up to a week and decided
 * by who looked when. The week is now computed here over its own bounds on the
 * family's clock, and only a parent or adult's view writes it: the history is
 * the household's record, not something a child's page view rewrites.
 */
export async function saveWorkloadSnapshotAction(): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!isManager(ctx.active.role)) return { ok: true };
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const tz = ctx.active.family.timezone || 'UTC';

  try {
    const weekStart = isoWeekStart(new Date(`${dayKeyInTz(new Date(), tz)}T00:00:00Z`));
    const fromIso = wallToInstant(wallFromKey(weekStart), tz).toISOString();
    const toIso = wallToInstant(wallFromKey(addDaysToDayKey(weekStart, 7)), tz).toISOString();
    const week = await weekLoads(supabase, familyId, fromIso, toIso);
    if (!week.report) {
      console.error('[workload] snapshot week read failed', { familyId, error: week.error });
      return { ok: false, error: t('actions.couldNotSaveWorkloadHistory') };
    }
    if (week.report.loads.every((l) => l.sharePct === 0)) return { ok: true };
    const { data: saved, error } = await supabase.from('workload_snapshots').upsert(
      week.report.loads.slice(0, 30).map(r => ({
        family_id: familyId,
        member_id: r.memberId,
        week_start: weekStart,
        chore_minutes: Math.max(0, Math.round(r.choreMinutes)),
        chore_count: Math.max(0, Math.round(r.choreCount)),
        task_count: Math.max(0, Math.round(r.taskCount)),
        event_count: Math.max(0, Math.round(r.eventCount)),
        load_score: Math.max(0, Math.min(100, Math.round(r.loadScore))),
        share_pct: Math.max(0, Math.min(100, r.sharePct)),
      })),
      { onConflict: 'family_id,member_id,week_start' },
    ).select('id');
    if (error) return { ok: false, error: describeActionError(error) };
    if (wroteNoRows(saved)) return { ok: false, error: t('actions.couldNotSaveWorkloadHistory') };
    return { ok: true };
  } catch {
    return { ok: false, error: t('actions.couldNotSaveWorkloadHistory') };
  }
}
