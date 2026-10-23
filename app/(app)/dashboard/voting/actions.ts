// Who runs a Group Voting poll: the person who asked it, or a parent or another
// adult (a manager). Nobody else closes, reopens or removes it.
//
// The voting page wrote family_polls straight from the browser and offered
// Close, Reopen and the bin to every member, and RLS on family_polls (0078,
// unchanged by 0481) lets any non-guest member update or delete any poll. So a
// child could close the parent's poll while their pick was ahead, reopen it
// after its deadline, or delete it. Its options were already the author's or a
// manager's (0481); the poll itself was not.
//
// These actions read the poll by id AND family, refuse anyone but its creator
// (`family_polls.created_by` is an auth user id, 0078) or a manager, and write
// through the caller's own session client, so RLS still applies underneath.
// The database half (an author-or-manager update/delete policy on family_polls)
// needs a schema change; until it lands the direct PostgREST path stays open.
'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { isPollClosed } from '@/lib/voting/polls';

const PATH = '/dashboard/voting';
const STATUSES = ['open', 'closed'] as const;

export type PollStatus = (typeof STATUSES)[number];

export type PollActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export type PollStatusResult =
  | { ok: true; id: string; status: string; closesAt: string | null }
  | { ok: false; error: string };

type Ctx = Awaited<ReturnType<typeof requireUserContext>>;
type Db = Awaited<ReturnType<typeof createServer>>;
type Tr = Awaited<ReturnType<typeof getTranslations>>;

/**
 * The poll this caller may run, or the answer to give instead. Another
 * family's poll, or one that is gone, answers as a change that did not save
 * (it is not confirmed to exist); a poll the caller may see but not run
 * answers "not allowed".
 */
async function runnablePoll(ctx: Ctx, db: Db, t: Tr, pollId: string): Promise<
  | { ok: true; poll: { id: string; status: string; closes_at: string | null } }
  | { ok: false; error: string }
> {
  if (!pollId) return { ok: false, error: t('errors.thatChangeWasNotSaved') };
  const { data, error } = await db.from('family_polls')
    .select('id, created_by, status, closes_at')
    .eq('id', pollId).eq('family_id', ctx.active.familyId)
    .maybeSingle();
  if (error) {
    console.error('[voting-action] poll read failed', error);
    return { ok: false, error: describeActionError(error, t('errors.thatChangeWasNotSaved')) };
  }
  if (!data) return { ok: false, error: t('errors.thatChangeWasNotSaved') };
  const mayRun = isManager(ctx.active.role) || (!!data.created_by && data.created_by === ctx.user.id);
  if (!mayRun) return { ok: false, error: t('actionRefusal.notAllowed') };
  return { ok: true, poll: data };
}

/** Close a poll, or open it again. */
export async function setPollStatusAction(pollId: string, status: PollStatus): Promise<PollStatusResult> {
  const t = await getTranslations();
  // Outside any try: `requireUserContext` redirects a signed-out caller by throwing.
  const ctx = await requireUserContext();
  if (!STATUSES.includes(status)) return { ok: false, error: t('errors.thatChangeWasNotSaved') };
  const db = await createServer();

  const found = await runnablePoll(ctx, db, t, pollId);
  if (!found.ok) return found;

  // A poll closed by its deadline stays closed whatever its status says, so
  // reopening one also clears the deadline; writing status alone was a click
  // that changed nothing.
  const reopenPastDeadline = status === 'open' && !!found.poll.closes_at
    && isPollClosed('open', found.poll.closes_at, new Date());
  const patch = reopenPastDeadline ? { status, closes_at: null } : { status };
  const { data: updated, error } = await db.from('family_polls').update(patch)
    .eq('id', pollId).eq('family_id', ctx.active.familyId)
    .select('id, status, closes_at');
  if (error) {
    console.error('[voting-action] poll status update failed', error);
    return { ok: false, error: describeActionError(error, t('errors.thatChangeWasNotSaved')) };
  }
  const row = updated?.[0];
  if (wroteNoRows(updated) || !row) return { ok: false, error: t('errors.thatChangeWasNotSaved') };
  if (status === 'open' && isPollClosed(row.status, row.closes_at, new Date())) {
    return { ok: false, error: t('errors.thatChangeWasNotSaved') };
  }

  revalidatePath(PATH);
  return { ok: true, id: row.id, status: row.status, closesAt: row.closes_at };
}

/** Remove a poll, with its options and votes (they cascade, 0078). */
export async function deletePollAction(pollId: string): Promise<PollActionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const db = await createServer();

  const found = await runnablePoll(ctx, db, t, pollId);
  if (!found.ok) return found;

  const { data: removed, error } = await db.from('family_polls').delete()
    .eq('id', pollId).eq('family_id', ctx.active.familyId)
    .select('id');
  if (error) {
    console.error('[voting-action] poll delete failed', error);
    return { ok: false, error: describeActionError(error, t('errors.thatChangeWasNotSaved')) };
  }
  if (wroteNoRows(removed)) return { ok: false, error: t('errors.thatChangeWasNotSaved') };

  revalidatePath(PATH);
  return { ok: true, id: pollId };
}
