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
// member's entry name the member (actor_id = auth.uid()) when it is written,
// so an entry INSERTED with no actor can only come from the service role: the
// reopen is written with actor_id null, the parent who reopened in
// metadata.reopened_by (the activity page names them from it, on this exact
// shape only), and the drain reads only such entries, and none dated after
// the moment it asks.
//
// A null actor marks the server's row only at insert time. audit_logs.actor_id
// is `references auth.users(id) on delete set null` (0002), so a member's own
// rows end with no actor once that member's login is deleted
// (removeChildLoginAction deletes a PIN child's; an erasure or a dashboard
// deletion anyone's).
// A member who wrote this exact shape, dated ahead, and whose login is later
// deleted, leaves an entry this cannot tell from the server's: every column of
// it but actor_id was the member's to choose, and every member can read every
// member's user id and role (fm_select), so naming a real parent proves
// nothing. Such an entry can only HOLD a post (never send one) that came due
// before its date, and only when the family row also changed between the due
// time and the drain's read. Closing that is the owner action above
// (families.reopened_at, written by the reopen itself), or an audit_insert
// that refuses a member's row of this shape (household-roles
// N5-R1-NULL-ACTOR-TRAIL-ATTRIBUTION, recorded there).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { logAudit } from '@/lib/server/audit';

const REOPENED = { action: 'update', resource: 'family', change: 'reopened' } as const;

/**
 * Record that the family's account was reopened, by whom, and the close it
 * ended. Written with the service client, after the reopen is confirmed, with
 * no actor: a member's own entry must name them when it is written (0380), so
 * an entry inserted without one is the server's, which is what
 * accountReopenedSince believes (see the header for a deleted member's rows).
 * Who reopened is kept in metadata.reopened_by. It is best-effort, as every audit
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
 * member when it is written, 0380, so a member who reopened nothing cannot
 * write one; a deleted member's rows lose their actor later, the residual the
 * header records), and none dated later than now (created_at is the
 * database's now() when the server writes it; a later one was not written by
 * a reopen that has happened).
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
