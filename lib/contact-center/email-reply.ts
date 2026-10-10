import 'server-only';
import { createHash } from 'node:crypto';
import type { createServiceClient } from '@/lib/supabase/server';

type Admin = ReturnType<typeof createServiceClient>;
const TOOL = 'contact_center.email_reply';

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function identity(familyId: string, providerRef: string) {
  const key = `${TOOL}:v1:${digest(JSON.stringify([familyId, 'email', providerRef]))}`;
  const hex = digest(key);
  return { id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`, key };
}

/**
 * The single right to auto-reply to one inbound email, keyed by (family,
 * provider ref) exactly as the SMS reply receipts are. A provider redelivers a
 * message whose first response was slow or lost, and every redelivery used to
 * send the sender another reply and write another outbound row. TRUE only for
 * the delivery whose insert created the reservation; a duplicate is FALSE. Any
 * other failure throws, and the caller skips the reply: at most once, never
 * twice.
 */
export async function reserveEmailReply(admin: Admin, input: { familyId: string; providerRef: string; messageId: string | null }): Promise<boolean> {
  const { id, key } = identity(input.familyId, input.providerRef);
  const saved = await admin.from('ai_tool_calls').insert({
    id, family_id: input.familyId, tool_name: TOOL, idempotency_key: key, actor_kind: 'system',
    requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null, request_id: null,
    conversation_id: null, message_id: null, inputs: { version: 1, providerRef: input.providerRef },
    outputs: { version: 1, phase: 'reserved' }, state: 'reserved', attempt: 1, locked_at: new Date().toISOString(),
    resource_table: 'family_inbox_messages', resource_id: input.messageId,
  }).select('id').abortSignal(AbortSignal.timeout(5000));
  if (!saved.error) return true;
  if (saved.error.code === '23505') return false;
  throw new Error('Email reply reservation failed');
}

/** Record how the reserved reply ended. Best effort: the reservation alone already prevents a repeat. */
export async function finishEmailReply(admin: Admin, input: { familyId: string; providerRef: string }, sent: boolean): Promise<void> {
  const { id } = identity(input.familyId, input.providerRef);
  const done = await admin.from('ai_tool_calls').update({
    outputs: { version: 1, phase: sent ? 'sent' : 'not_sent' }, state: sent ? 'succeeded' : 'failed', finished_at: new Date().toISOString(),
  }).eq('id', id).eq('family_id', input.familyId).eq('tool_name', TOOL).abortSignal(AbortSignal.timeout(5000));
  if (done.error) console.error('[contact-center] email reply receipt update failed');
}
