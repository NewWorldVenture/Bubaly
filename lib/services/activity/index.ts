// The durable record of what Bubaly did on the family's behalf — the feed the
// Command Center and /dashboard/agents read.
//
// Backed by `public.agent_activity` (migration 0127), which exists precisely
// for this: "the persistent record of what each agent surfaces or does". That
// scoping is why `recordActivity` is a no-op for `actorKind: 'member'`: a
// parent adding a to-do in the UI is not agent activity, and logging it here
// would bury the AI's work in manual noise. Manual edits are already
// observable through the rows themselves.
//
// Writes here are deliberately best-effort from a service's point of view: the
// feed entry describes a household write that has already committed, so
// failing the caller because the description could not be saved would trade a
// real outcome for a cosmetic one. The failure is still logged and returned.
import 'server-only';
import type { Tables } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type ActivityKind = 'insight' | 'recommendation' | 'action' | 'handoff';
export type ActivitySeverity = 'info' | 'attention' | 'action';
export type ActivityStatus = 'active' | 'done' | 'dismissed';

export type RecordActivityInput = {
  /** The agent or domain that acted, e.g. 'scheduler', 'calendar', 'groceries'. */
  agent: string;
  /** One line a family member can read without context, e.g. "Added Dentist to the calendar". */
  title: string;
  kind?: ActivityKind;
  detail?: string | null;
  /** Deep link to the thing that changed, e.g. '/dashboard/calendar'. */
  href?: string | null;
  /** Who the entry is about; null means the whole family. */
  memberId?: string | null;
  severity?: ActivitySeverity;
};

export type ActivityRow = Tables<'agent_activity'>;

/**
 * Append one entry to the agent activity feed.
 *
 * Returns `{ recorded: false }` (still `ok`) when the scope is a human acting
 * through the UI, so callers can write `await recordActivity(...)`
 * unconditionally without branching on actor kind at every call site.
 */
export async function recordActivity(
  scope: ServiceScope,
  input: RecordActivityInput,
): Promise<ServiceResult<{ id: string | null; recorded: boolean }>> {
  if (scope.actorKind === 'member') return ok({ id: null, recorded: false });

  const title = input.title.trim();
  if (!title) return fail('Activity needs a title.', { code: SERVICE_CODES.invalidInput });

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
  return ok({ id: data.id, recorded: true });
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
