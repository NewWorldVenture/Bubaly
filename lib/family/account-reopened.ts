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
// The reopen the drain believes is the SERVER'S, and it is kept where only the
// server writes. Round 5 had the drain read the audit_logs entry with no actor:
// any member may append to that trail (audit_insert, 0380), but must name
// themselves when they do, so an entry inserted with no actor was the service
// role's. That holds only at insert time. audit_logs.actor_id is `references
// auth.users(id) on delete set null` (0002), so a member's own rows end with no
// actor once that member's login is deleted (removeChildLoginAction deletes a
// PIN child's; an erasure or a dashboard deletion anyone's), and a member who
// wrote this entry's exact shape, dated ahead, and whose login was later
// deleted held the posts of a family that never closed whenever the family row
// also changed (household-roles N6-R1-REOPEN-RESIDUAL-HAS-A-CODE-ONLY-LEDGER).
//
// So the reopen is also recorded in social_audit_logs, and that record is the
// one the drain asks for. No member writes that table: 0356 dropped every
// member INSERT, UPDATE and DELETE policy on it, and nothing later gives one
// back; its only other writer is the social_write_audit trigger (0034), which
// records action = TG_OP ('INSERT', 'UPDATE', 'DELETE') and no metadata, so no
// member's write, and no row of a member whose login went, ever carries the
// reopen's action. Its readers are the super administrators' social audit page
// (app/(app)/admin/social/audit, which shows the action and the summary) and
// /family/activity, which credits the parent on the trail's reopen entry only
// when this record vouches for it (lib/activity/trail.ts). No export or privacy
// reader touches it.
//
// The audit_logs entry stays for /family/activity's "<parent> updated family",
// written with no actor and the parent in metadata.reopened_by, but nothing
// believes it alone: the drain reads only the ledger, and the activity page
// credits a parent on that entry's exact shape only beside a ledger record of
// the same reopen. Reopen entries written before this change (rounds 4 to 6,
// in audit_logs alone) are believed by neither: that writer never reached
// main, so no family has one the server wrote, and a post one would have held
// is sent, as it is when a reopen's record is lost.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { logAudit } from '@/lib/server/audit';

const REOPENED = { action: 'update', resource: 'family', change: 'reopened' } as const;
/** The reopen's record in social_audit_logs, the server-only ledger: its action. */
export const ACCOUNT_REOPENED_ACTION = 'account.reopened';

/**
 * Record that the family's account was reopened, by whom, and the close it
 * ended: the trail entry /family/activity reads, and the ledger record the
 * drain believes (social_audit_logs, which no member writes). Written with the
 * service client, after the reopen is confirmed, with no actor; who reopened
 * is kept in metadata.reopened_by. It is best-effort, as every audit row
 * written after the fact is (lib/server/audit): the account is open either way,
 * and a lost row is logged. A post that came due while the account was closed
 * is then sent late, as it was before round 3, rather than the family kept
 * closed over its own audit trail.
 */
export async function recordAccountReopened(
  admin: SupabaseClient<Database>,
  entry: { familyId: string; reopenedBy: string; closedAt: string },
): Promise<void> {
  await logAudit(admin, {
    familyId: entry.familyId, actorId: null, action: REOPENED.action, resource: REOPENED.resource,
    resourceId: entry.familyId, metadata: { change: REOPENED.change, closed_at: entry.closedAt, reopened_by: entry.reopenedBy },
  });
  const { data, error } = await admin.from('social_audit_logs').insert({
    family_id: entry.familyId, actor_id: null, action: ACCOUNT_REOPENED_ACTION, entity_type: 'family', entity_id: entry.familyId,
    summary: 'Account reopened', metadata: { closed_at: entry.closedAt, reopened_by: entry.reopenedBy },
  }).select('id');
  if (error || !data?.length) console.error('[account-reopened] the reopen was not recorded in the ledger', { familyId: entry.familyId, error: error ?? 'no row returned' });
}

/**
 * Whether the family's account was reopened after `since`: a reopen record in
 * the server-only ledger (social_audit_logs) later than that moment. `null`
 * when the ledger could not be read, which the caller must treat as unknown,
 * not as "no".
 *
 * Only that record counts, never the audit_logs entry, which a member's row
 * can come to look exactly like (see the header). None dated later than now
 * counts either: created_at is the database's now() when the server writes it.
 */
export async function accountReopenedSince(
  db: SupabaseClient<Database>,
  familyId: string,
  since: Date,
  signal: AbortSignal,
): Promise<boolean | null> {
  const { data, error } = await db.from('social_audit_logs').select('id')
    .eq('family_id', familyId).eq('action', ACCOUNT_REOPENED_ACTION)
    .gt('created_at', since.toISOString()).lte('created_at', new Date().toISOString())
    .order('created_at').order('id').limit(1).abortSignal(signal);
  if (error || !data) return null;
  return data.length > 0;
}
