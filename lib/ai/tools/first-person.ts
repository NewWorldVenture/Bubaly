// Tools whose output speaks in the requester's own first person.
//
// A family message posted with their name on it, an RSVP answering for them,
// an announcement on the board under their name (`createAnnouncement` writes
// `author_id`/`author_member_id` from the scope, and 0481 lets no member post
// as another directly).
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
import { createHash } from 'node:crypto';
import type { Database } from '@/lib/database.types';
import { getTool } from '@/lib/ai/tools/registry';

export const SPEAKS_FOR_THE_REQUESTER: ReadonlySet<string> = new Set(['messages.sendFamilyMessage', 'messages.createAnnouncement', 'calendar.rsvp']);

/** Whether this tool (by canonical name or alias — chat files `rsvp_to_event`, `create_announcement`) speaks for the requester. */
export function speaksForTheRequester(name: string | null | undefined): boolean {
  if (!name) return false;
  return SPEAKS_FOR_THE_REQUESTER.has(getTool(name)?.name ?? name);
}

/** One `modified` decision on the trust ledger: who edited, and what they changed. */
export type RecordedEdit = {
  actorId: string | null;
  changedFields: readonly string[] | null;
  createdAt?: string | null;
  firstPersonEdit?: unknown;
};

type EditIdentity = { familyId: string; approvalId: string; requesterMemberId: string | null | undefined };
type FirstPersonEdit = {
  version: 1;
  familyId: string;
  approvalId: string;
  requesterMemberId: string;
  toolNames: string[];
  argsDigest: string;
};

// Preserve values exactly; only object-key order is irrelevant. The service's
// idempotency digest trims strings, which would also certify changed wording.
function exactJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(exactJson).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${exactJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('The edited arguments are not JSON values.');
}

function exactArgsDigest(args: Record<string, unknown>): string | null {
  try { return createHash('sha256').update(exactJson(args)).digest('hex'); } catch { return null; }
}

/** Server-written evidence for the exact wording and the work it belongs to. */
export function firstPersonEditProof(
  identity: EditIdentity,
  toolNames: readonly string[],
  args: Record<string, unknown>,
): FirstPersonEdit | null {
  if (!identity.familyId || !identity.approvalId || !identity.requesterMemberId) return null;
  const names = [...new Set(toolNames.map((name) => getTool(name)?.name ?? name))].sort();
  if (!names.length || names.some((name) => !SPEAKS_FOR_THE_REQUESTER.has(name))) return null;
  const argsDigest = exactArgsDigest(args);
  return argsDigest ? { version: 1, ...identity, requesterMemberId: identity.requesterMemberId, toolNames: names, argsDigest } : null;
}

/**
 * Actor/field evidence alone does not identify the values a manager left in
 * `edited_payload`. Require the latest actual edit's protected digest to match
 * these exact arguments, this approval, its requester and this canonical tool.
 * Historical, malformed, unreadable or conflicting evidence is not permission
 * to run an edit. Two different edits with the same ledger timestamp are
 * ambiguous, so neither is chosen by an arbitrary row order.
 */
export function requesterEditedArgsAreProven(
  edits: readonly RecordedEdit[],
  identity: EditIdentity & { toolName: string },
  args: Record<string, unknown>,
): boolean {
  if (!editsAreTheRequesters(edits, identity.requesterMemberId)) return false;
  const actualEdits = edits.filter((edit) => edit.changedFields === null || edit.changedFields.length > 0);
  const times = actualEdits.map((edit) => edit.createdAt ? Date.parse(edit.createdAt) : NaN);
  if (times.some((time) => !Number.isFinite(time))) return false;
  const latest = Math.max(...times);
  const toolName = getTool(identity.toolName)?.name ?? identity.toolName;
  const digest = exactArgsDigest(args);
  if (!digest || !SPEAKS_FOR_THE_REQUESTER.has(toolName)) return false;
  return actualEdits.filter((_, index) => times[index] === latest).every((edit) => {
    if (edit.actorId !== identity.requesterMemberId || !edit.changedFields?.length) return false;
    const proof = edit.firstPersonEdit;
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
    const record = proof as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'approvalId,argsDigest,familyId,requesterMemberId,toolNames,version') return false;
    const names = record.toolNames;
    return record.version === 1 && record.familyId === identity.familyId && record.approvalId === identity.approvalId
      && record.requesterMemberId === identity.requesterMemberId && record.argsDigest === digest
      && Array.isArray(names) && names.length > 0 && names.every((name) => typeof name === 'string' && SPEAKS_FOR_THE_REQUESTER.has(name))
      && new Set(names).size === names.length && names.join(',') === [...names].sort().join(',') && names.includes(toolName);
  });
}

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
    .select('actor_id, context, created_at')
    .eq('family_id', familyId)
    .eq('approval_id', approvalId)
    .eq('actor_kind', 'member')
    .eq('decision', 'modified')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[ai/first-person] could not read who edited an approval', { approvalId, error });
    return null;
  }
  return (data ?? []).map((row) => {
    const context = row.context && typeof row.context === 'object' && !Array.isArray(row.context) ? row.context as Record<string, unknown> : {};
    const changed = context.changedByMe;
    return {
      actorId: row.actor_id ?? null,
      changedFields: Array.isArray(changed) && changed.every((key) => typeof key === 'string') ? changed : null,
      createdAt: row.created_at ?? null,
      firstPersonEdit: context.firstPersonEdit,
    };
  });
}
