// Two records of one change, kept apart on purpose.
//
// `public.agent_activity` (0127) is BUBALY'S ledger — "the persistent record of
// what each agent surfaces or does" — and /dashboard/agents renders it as the
// agent roster's feed while `lib/metric/time-saved-server.ts` counts its `done`
// rows as time the assistant saved. So it still takes nothing from a person
// acting through the UI: a parent adding a to-do is not agent activity, and
// writing it there would have Bubaly quietly taking credit for their work.
//
// `public.audit_logs` (0002) is the HOUSEHOLD'S record — rendered at
// /family/activity as "a running log of changes across your household" — and it
// takes every committed write regardless of who made it, tagged with which.
// That is the half that was missing: no domain service wrote to it at all, so
// the page a family opens to see who changed what has been empty since it
// shipped, and an event Bubaly added left a trace where the identical event a
// parent added by hand left none.
//
// Writes here are deliberately best-effort from a service's point of view: both
// entries describe a household write that has ALREADY COMMITTED, so failing the
// caller because a description could not be saved would trade a real outcome
// for a cosmetic one. Failures are logged.
import 'server-only';
import { type TrailAction } from '@/lib/activity/trail';
import type { Json, Tables } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type ActivityKind = 'insight' | 'recommendation' | 'action' | 'handoff';
export type ActivitySeverity = 'info' | 'attention' | 'action';
export type ActivityStatus = 'active' | 'done' | 'dismissed';

export type RecordActivityInput = {
  /** The agent or domain that acted, e.g. 'scheduler', 'calendar', 'groceries'. */
  agent: string;
  /**
   * What was done to it, for the household trail — or `null` for something that
   * changed nothing and so belongs only in Bubaly's own feed.
   *
   * Required rather than defaulted, and required even when it is `null`: a
   * wrong verb on a page a family reads is worse than a compile error here, and
   * "this changed nothing" is a claim worth making on purpose rather than by
   * forgetting an argument.
   */
  action: TrailAction | null;
  /** One line a family member can read without context, e.g. "Added Dentist to the calendar". */
  title: string;
  kind?: ActivityKind;
  detail?: string | null;
  /** Deep link to the thing that changed, e.g. '/dashboard/calendar'. */
  href?: string | null;
  /** Who the entry is about; null means the whole family. */
  memberId?: string | null;
  /** The row that changed, so the trail can point back at it. */
  resourceId?: string | null;
  severity?: ActivitySeverity;
};

export type ActivityRow = Tables<'agent_activity'>;

/**
 * Append the household trail entry for a committed write.
 *
 * Runs for EVERY actor — that is the whole point — and records which one, since
 * Bubaly acts inside a person's session and `actor_id` alone cannot tell "Dad
 * added it" from "Bubaly added it".
 *
 * Never throws and never changes the caller's outcome. The row it describes is
 * already committed; losing the description must not undo the change.
 *
 * Returns whether a row was written, which is false both for a caller that
 * changed nothing and for a failed insert. The two are distinguished in the log,
 * not in the return: no caller does anything different with them.
 */
async function appendHouseholdTrail(scope: ServiceScope, input: RecordActivityInput, title: string): Promise<boolean> {
  if (input.action === null) return false;

  const { error } = await scope.db.from('audit_logs').insert({
    family_id: scope.familyId,
    // audit_logs.actor_id references auth.users; a cron actor has none.
    actor_id: scope.userId,
    action: input.action,
    resource: input.agent,
    resource_id: input.resourceId ?? null,
    metadata: { actor: scope.actorKind, title } as Json,
  });
  if (error) {
    console.error('[service:activity] household trail entry dropped', error);
    return false;
  }
  return true;
}

/**
 * Record one committed change: always on the household trail, and on the agent
 * feed only when Bubaly was the one acting.
 *
 * Returns `{ recorded: false }` (still `ok`) when the scope is a human acting
 * through the UI, so callers can write `await recordActivity(...)`
 * unconditionally without branching on actor kind at every call site.
 * `trailed` reports the other half separately, because a person's change writes
 * one row and Bubaly's writes two.
 */
export async function recordActivity(
  scope: ServiceScope,
  input: RecordActivityInput,
): Promise<ServiceResult<{ id: string | null; recorded: boolean; trailed: boolean }>> {
  const title = input.title.trim();
  if (!title) return fail('Activity needs a title.', { code: SERVICE_CODES.invalidInput });

  // Before the actor-kind branch, so the household record is complete even
  // though the agent feed deliberately is not.
  const trailed = await appendHouseholdTrail(scope, input, title);
  if (scope.actorKind === 'member') return ok({ id: null, recorded: false, trailed });

  const { data, error } = await scope.db
    .from('agent_activity')
    .insert({
      family_id: scope.familyId,
      member_id: input.memberId ?? null,
      agent: input.agent,
      kind: input.kind ?? 'action',
      title,
      detail: input.detail ?? null,
      href: input.href ?? null,
      severity: input.severity ?? 'info',
      status: 'active',
      // agent_activity.created_by references auth.users; a cron actor has none.
      created_by: scope.userId,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('[service:activity] record failed', error);
    return fail(describeDbError(error, 'Could not record that activity.'), { code: SERVICE_CODES.db });
  }
  return ok({ id: data.id, recorded: true, trailed });
}

/**
 * Record an entry without letting its failure change the caller's outcome.
 * Used by the domain services after a committed write.
 */
export async function recordActivitySafely(scope: ServiceScope, input: RecordActivityInput): Promise<void> {
  const res = await recordActivity(scope, input);
  if (!res.ok) console.error('[service:activity] entry dropped for', input.agent, res.error);
}

/**
 * The feed, newest first. Paginated by `created_at` rather than offset so a
 * new entry arriving mid-scroll cannot shift the page boundary and hide a row.
 */
export async function listFeed(
  scope: ServiceScope,
  opts?: { limit?: number; before?: string | null; status?: ActivityStatus | 'all'; agent?: string },
): Promise<ServiceResult<{ items: ActivityRow[]; nextCursor: string | null }>> {
  const limit = Math.min(Math.max(opts?.limit ?? 25, 1), 100);
  let query = scope.db
    .from('agent_activity')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('created_at', { ascending: false })
    .limit(limit + 1);

  const status = opts?.status ?? 'active';
  if (status !== 'all') query = query.eq('status', status);
  if (opts?.agent) query = query.eq('agent', opts.agent);
  if (opts?.before) query = query.lt('created_at', opts.before);

  const { data, error } = await query;
  if (error) {
    console.error('[service:activity] feed read failed', error);
    return fail(describeDbError(error, 'Could not load the activity feed.'), { code: SERVICE_CODES.db });
  }

  const rows = data ?? [];
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? items[items.length - 1]?.created_at ?? null : null;
  return ok({ items, nextCursor });
}

/** Take an entry off the feed without deleting the history behind it. */
export async function setActivityStatus(
  scope: ServiceScope,
  activityId: string,
  status: ActivityStatus,
): Promise<ServiceResult<{ id: string }>> {
  const { data, error } = await scope.db
    .from('agent_activity')
    .update({ status })
    .eq('id', activityId)
    .eq('family_id', scope.familyId)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[service:activity] status update failed', error);
    return fail(describeDbError(error, 'Could not update that activity.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That activity could not be found.', { code: SERVICE_CODES.notFound });
  return ok({ id: data.id });
}
