// lib/trust/ledger.ts — who writes the trust ledger.
//
// trust_audit_logs is the record a family can point at to say "this is what
// Bubaly did and this is who said yes". 0260 removed the member INSERT policy,
// so the only writer left is server code holding the service role. Every
// recorder in the codebase goes through this one name, which is the general
// `serverWriter` under a name that says what it is for here.
import 'server-only';
import type { Json } from '@/lib/database.types';
import { serverWriter } from '@/lib/supabase/service-writer';

export { serverWriter as ledgerWriter } from '@/lib/supabase/service-writer';

/**
 * The schema reserves five decision values for changes to the RULES rather than
 * for decisions taken under them — `trust_audit_logs_decision_check` has named
 * them since the table shipped, and until C1-S8-04 nothing wrote a single one.
 * The ledger recorded every decision the permission system made and nothing at
 * all about who changed the permission system. This type carries the four that
 * can be written.
 *
 * `role_changed` is absent on purpose: family roles are edited by a direct
 * browser write in `components/modules/family-module.tsx` with no server action
 * in the path, and this table is service-role-only, so there is nowhere for
 * that row to be written from. Recorded in the audit rather than papered over.
 */
export type TrustChange =
  | 'policy_changed'
  | 'grant_changed'
  | 'delegation_changed'
  | 'emergency_ended';

type LedgerDb = { from: (table: string) => { insert: (row: Record<string, unknown>) => Promise<{ error: unknown }> } };

/**
 * Record a change to the permission system itself.
 *
 * Never throws and never fails its caller. The change has already landed by the
 * time this runs, and rolling a parent's edit back because an audit row did not
 * write would be a worse outcome than a gap in the log — the same reasoning
 * `lib/services/approvals` states for a lost decision row. A failure is loud in
 * the server logs instead of silent, which is the part that was missing: the
 * one existing writer on this surface (`activateEmergencyAction`) discarded its
 * error entirely, so a ledger that had stopped recording looked exactly like a
 * family that had done nothing.
 *
 * The one call that must NOT follow this rule is the privacy export, which
 * refuses to hand over the data when its own receipt cannot be written. That is
 * deliberate and stays as it is: there the ledger row is the point.
 */
export async function recordTrustChange(db: unknown, entry: {
  familyId: string;
  actorMemberId: string | null;
  decision: TrustChange;
  domain?: string | null;
  capability?: string | null;
  reason: string;
  context?: Record<string, unknown>;
}): Promise<void> {
  const writer = await serverWriter(db as LedgerDb);
  const { error } = await writer.from('trust_audit_logs').insert({
    family_id: entry.familyId,
    actor_kind: 'member',
    actor_id: entry.actorMemberId,
    domain: entry.domain ?? null,
    capability: entry.capability ?? null,
    decision: entry.decision,
    reason: entry.reason,
    context: (entry.context ?? {}) as Json,
  });
  if (error) {
    console.error('[trust-ledger] a permission change was made but not recorded',
      { familyId: entry.familyId, decision: entry.decision, domain: entry.domain }, error);
  }
}
