import 'server-only';
import type { Database } from '@/lib/database.types';
import type { ToolOutcome } from '@/lib/ai/tools/types';
import { getTool } from '@/lib/ai/tools/registry';
import { asRecord } from '@/lib/approvals/card-data';
import { markInboxMessageHandled } from '@/lib/services/inbox';
import { makeKey } from '@/lib/services/idempotency';
import type { ServiceScope } from '@/lib/services/types';
import { ledgerWriter } from '@/lib/trust/ledger';

export const SCHOOL_DESK_AGENT = 'School & Sports desk';
const SOURCE_KIND = 'school_front_desk';

/** Stored beside tool arguments, so edits to the proposed work retain its source. */
export function schoolProposalSource(messageId: string) {
  return { kind: SOURCE_KIND, message_id: messageId };
}

type Approval = Database['public']['Tables']['approval_requests']['Row'];

/**
 * A source can remain unhandled after its action succeeded. Propose must repair
 * that bookkeeping, including edited work, instead of issuing a new write.
 * An approved action with no successful receipt is ambiguous: leave it for
 * review rather than guessing that nothing happened and duplicating it.
 */
export async function recoverSchoolProposal(
  scope: ServiceScope,
  messageId: string,
): Promise<'none' | 'handled' | 'review' | 'unavailable'> {
  try {
    const { data: previous, error } = await scope.db.from('approval_requests')
      .select('*')
      .eq('family_id', scope.familyId)
      .eq('requested_by_kind', 'ai')
      .eq('agent', SCHOOL_DESK_AGENT)
      .in('status', ['approved', 'modified'])
      .contains('payload', { source: schoolProposalSource(messageId) })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[school-desk] previous proposal read failed', error);
      return 'unavailable';
    }
    if (!previous) return 'none';
    const payload = asRecord(previous.payload);
    if (typeof payload?.name !== 'string') return 'review';
    const { data: call, error: callError } = await scope.db.from('ai_tool_calls')
      .select('id, state, outputs, error')
      .eq('family_id', scope.familyId)
      .eq('idempotency_key', makeKey([scope.familyId, 'approval', previous.id, payload.name]))
      .maybeSingle();
    if (callError) console.error('[school-desk] previous execution read failed', callError);
    if (callError || !call || call.state !== 'succeeded' || call.error) return 'review';
    const outputs = asRecord(call.outputs);
    // Unverified or malformed outputs remain a review, just as on first run.
    if (outputs?.verified === false || !outputs || !('result' in outputs)) return 'review';
    const handled = await markApprovedSchoolSource(scope, previous, {
      status: 'ok', data: outputs.result, summary: previous.execution_result ?? '',
      toolCallId: call.id, ...(typeof outputs.verified === 'boolean' ? { verified: outputs.verified } : {}),
    });
    return handled === true ? 'handled' : 'review';
  } catch (error) {
    console.error('[school-desk] previous proposal recovery failed', error);
    return 'unavailable';
  }
}

/** Null means another surface; false means the work's source remains unhandled. */
export async function markApprovedSchoolSource(
  scope: ServiceScope,
  row: Approval,
  outcome: Extract<ToolOutcome, { status: 'ok' }>,
): Promise<boolean | null> {
  const payload = asRecord(row.payload);
  const source = asRecord(payload?.source);
  if (row.family_id !== scope.familyId || row.requested_by_kind !== 'ai'
    || row.agent !== SCHOOL_DESK_AGENT || source?.kind !== SOURCE_KIND) return null;
  const messageId = source.message_id;
  if (typeof messageId !== 'string' || !messageId.trim() || !outcome.toolCallId || outcome.verified === false) return false;

  try {
    const writer = await ledgerWriter(scope.db);
    // A successful tool outcome can outlive a failed ledger finalization. Do
    // not claim Handled unless the database confirms this family's tool write.
    const { data: call, error } = await writer.from('ai_tool_calls')
      .select('id, tool_name')
      .eq('id', outcome.toolCallId)
      .eq('family_id', scope.familyId)
      .eq('state', 'succeeded')
      .maybeSingle();
    if (error) console.error('[school-desk] execution receipt read failed', error);
    const tool = typeof payload?.name === 'string' ? getTool(payload.name) : null;
    if (error || !call || !tool || call.tool_name !== tool.name) return false;
    const marked = await markInboxMessageHandled({ ...scope, db: writer }, messageId, 'archived');
    return marked.ok && marked.data.ai_handled === true;
  } catch (error) {
    // The household write already succeeded; a bookkeeping failure must never
    // turn it into a retry that executes the same work again.
    console.error('[school-desk] source completion failed', error);
    return false;
  }
}
