import 'server-only';
import type { Database, Json } from '@/lib/database.types';
import { ROLE_ORDER, type MemberRole } from '@/lib/constants/roles';
import { ledgerWriter } from '@/lib/trust/ledger';
import { executeTool } from '@/lib/ai/tools/execute';
import { getTool } from '@/lib/ai/tools/registry';
import { asRecord, editableFieldsFor } from '@/lib/approvals/card-data';
import { getTranslations } from '@/lib/i18n/server';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';

type Approval = Database['public']['Tables']['approval_requests']['Row'];
const TOOL = 'finances.advisePurchase';
const RESULT_KIND = 'purchase_advice_result';
const unavailable = async () => fail((await getTranslations())('purchaseAdvice.privateUnavailable'), { code: SERVICE_CODES.db, retryable: true });
const denied = async () => fail((await getTranslations())('purchaseAdvice.privateDenied'), { code: SERVICE_CODES.denied });

function purchaseArgs(row: Approval): Record<string, unknown> | null {
  const payload = row.payload as { name?: unknown; args?: unknown } | null;
  return row.requested_by_kind === 'ai' && payload?.name === TOOL && payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
    ? payload.args as Record<string, unknown> : null;
}

/** Match approval execution's editable-field allowlist and schema check so a
 * delivery retry reads the agreed item/price, including a parent's edits. */
function approvedPurchaseArgs(row: Approval): Record<string, unknown> | null {
  const original = purchaseArgs(row);
  if (!original) return null;
  const stored = asRecord(row.edited_payload);
  if (!stored) return original;
  const allowed = new Set(editableFieldsFor(original).map((field) => field.key));
  const merged = { ...original };
  for (const [key, value] of Object.entries(stored)) {
    if (allowed.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) merged[key] = value;
  }
  return getTool(TOOL)?.input.safeParse(merged).success ? merged : null;
}

/** Approval grants the read, never the approver's visibility. Resolve the
 * original request against a still-active login before any private source is
 * read. Missing/removed requesters have no fallback identity or adult role. */
export async function scopeForApprovedPurchase(scope: ServiceScope, row: Approval): Promise<ServiceResult<ServiceScope>> {
  if (row.family_id !== scope.familyId || !purchaseArgs(row) || !row.request_id || !row.requested_by_member_id) return denied();
  try {
    const db = await ledgerWriter(scope.db);
    const request = await db.from('ai_requests').select('id, requested_by, requested_by_member_id')
      .eq('family_id', scope.familyId).eq('id', row.request_id).eq('requested_by_member_id', row.requested_by_member_id).maybeSingle();
    if (request.error) throw request.error;
    if (!request.data?.requested_by) return denied();
    const member = await db.from('family_members').select('id, user_id, role')
      .eq('family_id', scope.familyId).eq('id', row.requested_by_member_id)
      .eq('user_id', request.data.requested_by).eq('is_active', true).maybeSingle();
    if (member.error) throw member.error;
    if (!member.data?.user_id || !ROLE_ORDER.includes(member.data.role as MemberRole)) return denied();
    return ok({ ...scope, db, actorKind: 'ai', role: member.data.role as MemberRole,
      userId: member.data.user_id, memberId: member.data.id, requestId: row.request_id });
  } catch (error) {
    console.error('[purchase-result] requester read failed', error);
    return unavailable();
  }
}

/** The complete report lives only in owner-protected conversations/messages.
 * The deterministic ids make a repeated delivery harmless; owner checks make
 * pre-existing ids fail closed rather than overwrite someone else's rows. */
export async function savePrivatePurchaseAnswer(scope: ServiceScope, approvalId: string, answer: string): Promise<ServiceResult<null>> {
  if (!scope.userId || !scope.memberId || !scope.requestId || !answer.trim()) return denied();
  try {
    const db = await ledgerWriter(scope.db);
    const request = await db.from('ai_requests').select('conversation_id').eq('id', scope.requestId)
      .eq('family_id', scope.familyId).eq('requested_by', scope.userId).eq('requested_by_member_id', scope.memberId).maybeSingle();
    if (request.error) throw request.error;
    if (!request.data) return denied();
    const conversationId = request.data.conversation_id ?? approvalId;
    if (!request.data.conversation_id) {
      const conversation = await db.from('ai_conversations').insert({ id: conversationId, family_id: scope.familyId, user_id: scope.userId });
      if (conversation.error && conversation.error.code !== '23505') throw conversation.error;
    }
    const owner = await db.from('ai_conversations').select('id').eq('id', conversationId)
      .eq('family_id', scope.familyId).eq('user_id', scope.userId).maybeSingle();
    if (owner.error) throw owner.error;
    if (!owner.data) return denied();
    const message = await db.from('ai_messages').insert({
      id: approvalId, family_id: scope.familyId, conversation_id: conversationId,
      role: 'assistant', content: answer, request_id: scope.requestId,
      structured_content: { kind: RESULT_KIND, approvalId } as Json,
    });
    if (message.error && message.error.code !== '23505') throw message.error;
    const saved = await db.from('ai_messages').select('id').eq('id', approvalId).eq('family_id', scope.familyId)
      .eq('conversation_id', conversationId).eq('request_id', scope.requestId).eq('role', 'assistant')
      .contains('structured_content', { kind: RESULT_KIND, approvalId }).maybeSingle();
    if (saved.error) throw saved.error;
    return saved.data ? ok(null) : denied();
  } catch (error) {
    console.error('[purchase-result] private delivery failed', error);
    return unavailable();
  }
}

export type PrivatePurchaseResult = { kind: 'ready'; answer: string } | { kind: 'waiting' | 'declined' | 'retry' };

/** This owner proof is required even with a service client in a test/server. */
async function ownedApproval(scope: ServiceScope, approvalId: string): Promise<ServiceResult<Approval>> {
  if (!scope.userId || !scope.memberId) return denied();
  const row = await scope.db.from('approval_requests').select('*').eq('id', approvalId)
    .eq('family_id', scope.familyId).eq('requested_by_member_id', scope.memberId).maybeSingle();
  if (row.error) throw row.error;
  if (!row.data || !purchaseArgs(row.data)) return denied();
  const requester = await scopeForApprovedPurchase(scope, row.data);
  if (!requester.ok) return requester;
  return requester.data.userId === scope.userId && requester.data.memberId === scope.memberId ? ok(row.data) : denied();
}

export async function loadPrivatePurchaseAnswer(scope: ServiceScope, approvalId: string): Promise<ServiceResult<PrivatePurchaseResult>> {
  try {
    const owned = await ownedApproval(scope, approvalId);
    if (!owned.ok) return owned;
    const row = owned.data;
    if (row.status === 'pending') return ok({ kind: 'waiting' });
    if (!['approved', 'modified'].includes(row.status)) return ok({ kind: 'declined' });
    const message = await scope.db.from('ai_messages').select('content, conversation_id').eq('id', approvalId)
      .eq('family_id', scope.familyId).eq('request_id', row.request_id!).eq('role', 'assistant')
      .contains('structured_content', { kind: RESULT_KIND, approvalId }).maybeSingle();
    if (message.error) throw message.error;
    if (!message.data) return ok({ kind: 'retry' });
    const owner = await scope.db.from('ai_conversations').select('id').eq('id', message.data.conversation_id)
      .eq('family_id', scope.familyId).eq('user_id', scope.userId!).maybeSingle();
    if (owner.error) throw owner.error;
    return owner.data ? ok({ kind: 'ready', answer: message.data.content }) : denied();
  } catch (error) {
    console.error('[purchase-result] private answer read failed', error);
    return unavailable();
  }
}

/** A failed delivery can be retried only by its owner, only for this specific
 * read, and only against a persisted AI approval that has been granted. */
export async function retryPrivatePurchaseAnswer(scope: ServiceScope, approvalId: string): Promise<ServiceResult<null>> {
  try {
    const owned = await ownedApproval(scope, approvalId);
    if (!owned.ok) return owned;
    const row = owned.data;
    if (!['approved', 'modified'].includes(row.status)) return denied();
    const current = await loadPrivatePurchaseAnswer(scope, approvalId);
    if (!current.ok) return current;
    if (current.data.kind === 'ready') return ok(null);
    const requester = await scopeForApprovedPurchase(scope, row);
    if (!requester.ok) return requester;
    const args = approvedPurchaseArgs(row);
    if (!args) return denied();
    const result = await executeTool(requester.data, TOOL, args, { skipTrust: true, requestId: row.request_id });
    if (result.status !== 'ok') return unavailable();
    const answer = (result.data as { answer?: unknown } | null)?.answer;
    if (typeof answer !== 'string') return unavailable();
    const saved = await savePrivatePurchaseAnswer(requester.data, row.id, answer);
    if (!saved.ok) return saved;
    const t = await getTranslations();
    const writer = await ledgerWriter(scope.db);
    const stamped = await writer.from('approval_requests').update({ execution_result: t('purchaseAdvice.checked'), executed_at: new Date().toISOString() })
      .eq('id', row.id).eq('family_id', scope.familyId).in('status', ['approved', 'modified']);
    if (stamped.error) throw stamped.error;
    return ok(null);
  } catch (error) {
    console.error('[purchase-result] private retry failed', error);
    return unavailable();
  }
}
