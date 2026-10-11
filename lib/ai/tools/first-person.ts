// Tools whose output speaks in the requester's own first person.
//
// A family message posted with their name on it, an RSVP answering for them.
// Approved and planned work runs AS the person who asked — a run on the
// service client under their member and user ids (lib/ai/runs/executor.ts
// `scopeFor`), a Bubaly-filed approval replayed for its asker
// (lib/services/approvals `scopeForApprovedWork`) — and `send_family_message`'s
// "send only as yourself" lock does not check the service role (0475). So the
// words of these tools are the requester's to change, and nobody else's: an
// edit by another manager — to a run step (lib/ai/runs/controls.ts
// `editStepInput`) or through Approve-with-edits (lib/services/approvals
// `editAndApprove`) — went out with the requester's name on it.
//
// Shared by every place an edit can reach one of these tools, so the list is
// one list.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getTool } from '@/lib/ai/tools/registry';

export const SPEAKS_FOR_THE_REQUESTER: ReadonlySet<string> = new Set(['messages.sendFamilyMessage', 'calendar.rsvp']);

/** Whether this tool (by canonical name or alias — chat files `rsvp_to_event`) speaks for the requester. */
export function speaksForTheRequester(name: string | null | undefined): boolean {
  if (!name) return false;
  return SPEAKS_FOR_THE_REQUESTER.has(getTool(name)?.name ?? name);
}

/** One `modified` decision on the trust ledger: who edited, and what they changed. */
export type RecordedEdit = { actorId: string | null; changedFields: readonly string[] | null };

/**
 * Whether every edit recorded on an approval is the requester's own.
 *
 * `edited_payload` is a column any manager may write on a pending row
 * (`approval_requests_decide`, 0251), so the column cannot say who wrote it.
 * The trust ledger can: `editAndApprove` records each approver's own changes
 * (`changedByMe`) under their member id, through the service role, and 0260
 * leaves members no way to write that table. An edit with no such record — the
 * column written directly — is nobody's, so it is not the requester's either.
 *
 * An approver whose recorded edit changed nothing (they approved what was
 * already there) is not an editor. A record that does not say what it changed
 * is counted as an edit.
 */
export function editsAreTheRequesters(edits: readonly RecordedEdit[], requesterMemberId: string | null | undefined): boolean {
  if (!requesterMemberId) return false;
  const editors = edits.filter((e) => e.changedFields === null || e.changedFields.length > 0).map((e) => e.actorId);
  return editors.length > 0 && editors.every((id) => id === requesterMemberId);
}

/**
 * The `modified` decisions the ledger holds for an approval. Null when they
 * cannot be read — "not proven", which the callers treat as not the
 * requester's.
 */
export async function recordedEditsOf(
  db: SupabaseClient<Database>,
  familyId: string,
  approvalId: string,
): Promise<RecordedEdit[] | null> {
  const { data, error } = await db
    .from('trust_audit_logs')
    .select('actor_id, context')
    .eq('family_id', familyId)
    .eq('approval_id', approvalId)
    .eq('actor_kind', 'member')
    .eq('decision', 'modified');
  if (error) {
    console.error('[ai/first-person] could not read who edited an approval', { approvalId, error });
    return null;
  }
  return (data ?? []).map((row) => {
    const context = row.context && typeof row.context === 'object' && !Array.isArray(row.context) ? row.context as Record<string, unknown> : {};
    const changed = context.changedByMe;
    return {
      actorId: row.actor_id ?? null,
      changedFields: Array.isArray(changed) ? changed.filter((k): k is string => typeof k === 'string') : null,
    };
  });
}
