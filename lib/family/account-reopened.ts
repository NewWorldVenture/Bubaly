// The family's own record that its account was reopened, and the one question
// asked of it: was the account reopened after a given moment?
//
// Closing sets families.closed_at and reopening clears it; neither left any
// other trace, so nothing could tell afterwards WHEN a family had reopened. The
// social drain needs exactly that (lib/social/scheduled-publish.ts): no cron
// looks at a closed family, so a post that came due while the account was
// closed is still queued when it reopens, and must be held rather than sent
// late. Round 3 read the reopen time from families.updated_at, which the
// database stamps on EVERY change to the row (a rename, the address, the time
// zone, the cover, onboarding), so an open family that edited its profile
// after a post came due, before the drain reached it, had the post held as
// "came due while closed" (household-roles N3-R1-CLOSED-FALSE-HOLD).
//
// reopenAccountAction now appends this entry to the family's audit trail (the
// household activity page reads it as "<parent> updated family"), and the
// drain asks for one later than the time the post came due. A dedicated
// column (families.reopened_at, set as closed_at goes back to null) would be
// the database's own answer; that is an owner action (SQL), and this record
// is what the code can keep until then.
//
// The entry is the SERVER'S, and only the server's is believed. Any member may
// append to their family's trail (audit_insert, 0380), so a child or a guest
// could write the same action, resource and metadata, dated 2100, and every
// later post of a family that never closed was held whenever a manager edited
// the family row (household-roles N4-R1-REOPEN-ROW-FORGEABLE). 0380 makes a
// member's entry name the member (actor_id = auth.uid()), so an entry with NO
// actor can only come from the service role: the reopen is written with
// actor_id null, the parent who reopened in metadata.reopened_by (the
// activity page names them from it), and the drain reads only such entries,
// and none dated after the moment it asks.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { logAudit } from '@/lib/server/audit';

const REOPENED = { action: 'update', resource: 'family', change: 'reopened' } as const;

/**
 * Record that the family's account was reopened, by whom, and the close it
 * ended. Written with the service client, after the reopen is confirmed, with
 * no actor: a member's own entry must name them (0380), so an entry without
 * one is the server's, which is what accountReopenedSince believes. Who
 * reopened is kept in metadata.reopened_by. It is best-effort, as every audit
 * row written after the fact is (lib/server/audit): the account is open either
 * way, and a lost row is logged. A post that came due while the account was
 * closed is then sent late, as it was before round 3, rather than the family
 * kept closed over its own audit trail.
 */
export async function recordAccountReopened(
  admin: SupabaseClient<Database>,
  entry: { familyId: string; reopenedBy: string; closedAt: string },
): Promise<void> {
  await logAudit(admin, {
    familyId: entry.familyId, actorId: null, action: REOPENED.action, resource: REOPENED.resource,
    resourceId: entry.familyId, metadata: { change: REOPENED.change, closed_at: entry.closedAt, reopened_by: entry.reopenedBy },
  });
}

/**
 * Whether the family's account was reopened after `since`: a reopen entry in
 * its audit trail later than that moment. `null` when the trail could not be
 * read, which the caller must treat as unknown, not as "no".
 *
 * Only the server's entry counts: one with no actor (a member's must name the
 * member, 0380, so a member who reopened nothing cannot write one), and none
 * dated later than now (created_at is the database's now() when the server
 * writes it; a later one was not written by a reopen that has happened).
 */
export async function accountReopenedSince(
  db: SupabaseClient<Database>,
  familyId: string,
  since: Date,
  signal: AbortSignal,
): Promise<boolean | null> {
  const { data, error } = await db.from('audit_logs').select('id')
    .eq('family_id', familyId).is('actor_id', null).eq('action', REOPENED.action).eq('resource', REOPENED.resource)
    .contains('metadata', { change: REOPENED.change })
    .gt('created_at', since.toISOString()).lte('created_at', new Date().toISOString())
    .order('created_at').order('id').limit(1).abortSignal(signal);
  if (error || !data) return null;
  return data.length > 0;
}
