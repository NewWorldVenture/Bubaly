import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { formatPhone } from './phone';

type Client = SupabaseClient<Database>;
type Options = { signal?: AbortSignal };
const TOOL = 'guardian.sms_intake';
const REQUEST_MS = 5000;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const inputSchema = z.object({
  smsSid: z.string().regex(/^(SM|MM)[0-9a-f]{32}$/i), familyId: uuid, memberId: uuid,
  from: z.string().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/).nullable(),
  to: z.string().regex(/^\+[1-9]\d{7,14}$/), body: z.string().max(4096),
}).strict();
const decisionSchema = z.object({
  status: z.enum(['received', 'blocked']), contact_id: uuid.nullable(), from_name: z.string().nullable(),
  trust_level_at_time: z.enum(['immediate_family', 'close_family', 'trusted_friend', 'known_contact', 'unknown', 'suspected_spam', 'blocked']),
  routing_mode_used: z.enum(['immediate_ring', 'immediate_ai_summary', 'ai_handle_first', 'voicemail_first', 'silent_handling', 'blocked']),
  routing_rule_id: uuid.nullable(), ai_decision_reason: z.string(), scam_detected: z.boolean(),
  scam_type: z.string().nullable(), scam_confidence: z.number().int().min(0).max(100),
}).strict();
const storedInputSchema = inputSchema.extend({ version: z.literal(1), communicationId: uuid }).strict();
const outputSchema = z.discriminatedUnion('phase', [
  z.object({ version: z.literal(1), revision: uuid, phase: z.literal('captured'), decision: z.null() }).strict(),
  z.object({ version: z.literal(1), revision: uuid, phase: z.literal('decided'), decision: decisionSchema }).strict(),
  z.object({ version: z.literal(1), revision: uuid, phase: z.literal('completed'), decision: decisionSchema,
    completedAt: z.string().refine(value => Number.isFinite(Date.parse(value))) }).strict(),
]);
const NULL_METADATA = ['requested_by', 'requested_by_member_id', 'run_id', 'plan_step_id', 'request_id', 'conversation_id', 'message_id', 'locked_at', 'duration_ms', 'error'] as const;
const COLUMNS = 'id,family_id,tool_name,actor_kind,requested_by,requested_by_member_id,run_id,plan_step_id,request_id,conversation_id,message_id,inputs,outputs,state,attempt,locked_at,duration_ms,error,idempotency_key,resource_table,resource_id,finished_at,created_at,updated_at';
export type GuardianSmsReceiptInput = z.infer<typeof inputSchema>;
export type GuardianSmsDecision = z.infer<typeof decisionSchema>;
export type GuardianSmsReceipt = {
  id: string; revision: string; input: GuardianSmsReceiptInput; communicationId: string; decision: GuardianSmsDecision | null;
  phase: 'captured' | 'decided' | 'completed'; completedAt: string | null;
};
export class GuardianSmsReceiptUnavailableError extends Error {
  constructor() { super('Guardian SMS receipt unavailable'); this.name = 'GuardianSmsReceiptUnavailableError'; }
}
function unavailable(): never { throw new GuardianSmsReceiptUnavailableError(); }
function identity(smsSid: string) {
  const key = `${TOOL}:v1:${smsSid.toLowerCase()}`;
  const hex = createHash('sha256').update(key).digest('hex');
  return { key, id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}` };
}
/** Find retained intake before resolving a destination that may have changed. */
export function guardianSmsReceiptId(smsSid: string): string {
  return identity(inputSchema.shape.smsSid.parse(smsSid)).id;
}
/** A retry writes the same notification primary key, including across workers. */
export function guardianSmsNotificationId(receiptId: string): string {
  const hex = createHash('sha256').update(`${uuid.parse(receiptId).toLowerCase()}:guardian-sms:notification`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function sameInput(a: GuardianSmsReceiptInput, b: GuardianSmsReceiptInput): boolean {
  return (Object.keys(inputSchema.shape) as Array<keyof GuardianSmsReceiptInput>).every(key => a[key] === b[key]);
}
function sameDecision(a: GuardianSmsDecision | null, b: GuardianSmsDecision): boolean {
  return a !== null && (Object.keys(decisionSchema.shape) as Array<keyof GuardianSmsDecision>).every(key => a[key] === b[key]);
}
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

function validate(raw: unknown, input: GuardianSmsReceiptInput): GuardianSmsReceipt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable();
  const row = raw as Record<string, unknown>;
  const stored = storedInputSchema.parse(row.inputs), output = outputSchema.parse(row.outputs), expected = identity(input.smsSid);
  if (!sameInput(stored, input) || row.id !== expected.id || row.family_id !== input.familyId
    || row.idempotency_key !== expected.key || row.tool_name !== TOOL || row.actor_kind !== 'system'
    || NULL_METADATA.some(key => row[key] !== null) || row.resource_table !== 'guardian_communications' || row.resource_id !== stored.communicationId
    || !timestamp(row.created_at) || !timestamp(row.updated_at)
    || (output.phase === 'captured'
      ? row.state !== 'reserved' || row.attempt !== 0 || row.finished_at !== null
      : row.state !== 'succeeded' || row.attempt !== 1 || !timestamp(row.finished_at))) return unavailable();
  return { id: expected.id, revision: output.revision, input, communicationId: stored.communicationId, decision: output.decision,
    phase: output.phase, completedAt: output.phase === 'completed' ? output.completedAt : null };
}

/** One deadline covers read/write/reconciliation; late transports cannot resume the caller. */
async function bounded<T>(options: Options | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('SMS receipt interrupted', 'AbortError'));
  options?.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, REQUEST_MS);
  try {
    if (options?.signal?.aborted) abort();
    if (controller.signal.aborted) return unavailable();
    const result = await run(controller.signal);
    if (controller.signal.aborted) return unavailable();
    return result;
  } catch { return unavailable(); }
  finally { clearTimeout(timer); options?.signal?.removeEventListener('abort', abort); }
}
async function request<T>(signal: AbortSignal, run: () => PromiseLike<T>): Promise<T> {
  let abort: () => void = () => {};
  try {
    if (signal.aborted) return unavailable();
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new GuardianSmsReceiptUnavailableError());
      signal.addEventListener('abort', abort, { once: true });
    });
    const result = await Promise.race([Promise.resolve().then(() => { if (signal.aborted) return unavailable(); return run(); }), interrupted]);
    if (signal.aborted) return unavailable();
    return result;
  } finally { signal.removeEventListener('abort', abort); }
}
async function read(client: Client, input: GuardianSmsReceiptInput, signal: AbortSignal): Promise<GuardianSmsReceipt | null> {
  const saved = await readById(client, identity(input.smsSid).id, signal);
  if (saved && !sameInput(saved.input, input)) return unavailable();
  return saved;
}
async function readById(client: Client, id: string, signal: AbortSignal): Promise<GuardianSmsReceipt | null> {
  const result = await request(signal, () => client.from('ai_tool_calls').select(COLUMNS, { count: 'exact' })
    .eq('id', id).limit(2).retry(false).abortSignal(signal));
  if (result.error || !Array.isArray(result.data) || result.count !== result.data.length || result.data.length > 1) return unavailable();
  if (!result.data.length) return null;
  const row = result.data[0];
  if (!row || typeof row !== 'object' || row.id !== id) return unavailable();
  const { version: _version, communicationId: _pointer, ...input } = storedInputSchema.parse(row.inputs);
  return validate(row, input);
}

/** Read authorship from the service-writable ledger, never from a communication row. */
export function readGuardianSmsReceipt(client: Client, input: GuardianSmsReceiptInput, options?: Options): Promise<GuardianSmsReceipt | null> {
  return bounded(options, signal => read(client, inputSchema.parse(input), signal));
}

/** Recovery obtains its payload only from a fully validated service-owned receipt. */
export function readGuardianSmsReceiptById(client: Client, id: string, options?: Options): Promise<GuardianSmsReceipt | null> {
  return bounded(options, signal => readById(client, uuid.parse(id), signal));
}

/** Called only after authenticating the inbound payload. Capture carries no decision. */
export function captureGuardianSmsReceipt(client: Client, input: GuardianSmsReceiptInput, communicationId: string, options?: Options): Promise<GuardianSmsReceipt> {
  return bounded(options, async signal => {
    const parsed = inputSchema.parse(input), pointer = uuid.parse(communicationId), expected = identity(parsed.smsSid);
    let saved = await read(client, parsed, signal);
    if (!saved) {
      try {
        await request(signal, () => client.from('ai_tool_calls').insert({
          id: expected.id, family_id: parsed.familyId, tool_name: TOOL, idempotency_key: expected.key, actor_kind: 'system',
          requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null, request_id: null, conversation_id: null, message_id: null,
          inputs: { ...parsed, version: 1, communicationId: pointer },
          outputs: { version: 1, revision: randomUUID(), phase: 'captured', decision: null },
          state: 'reserved', attempt: 0, resource_table: 'guardian_communications', resource_id: pointer,
          locked_at: null, duration_ms: null, error: null, finished_at: null,
        }).select('id').retry(false).abortSignal(signal));
      } catch { /* A lost response is recoverable only through the exact saved receipt. */ }
      saved = await read(client, parsed, signal);
    }
    if (!saved || saved.communicationId !== pointer) return unavailable();
    return saved;
  });
}

/** Persist the fresh decision before updating the communication; a decided receipt is immutable. */
export function saveGuardianSmsDecision(client: Client, receipt: GuardianSmsReceipt, decision: GuardianSmsDecision, options?: Options): Promise<GuardianSmsReceipt> {
  return bounded(options, async signal => {
    const input = inputSchema.parse(receipt.input), nextDecision = decisionSchema.parse(decision), pointer = uuid.parse(receipt.communicationId);
    const expected = identity(input.smsSid);
    if (receipt.id !== expected.id || !uuid.safeParse(receipt.revision).success) return unavailable();
    const current = await read(client, input, signal);
    if (!current || current.communicationId !== pointer) return unavailable();
    if (current.decision) { if (!sameDecision(current.decision, nextDecision)) return unavailable(); return current; }
    if (current.revision !== receipt.revision || receipt.decision !== null) return unavailable();
    try {
      await request(signal, () => client.from('ai_tool_calls').update({
        outputs: { version: 1, revision: randomUUID(), phase: 'decided', decision: nextDecision },
        state: 'succeeded', attempt: 1, finished_at: new Date().toISOString(),
      }).eq('id', expected.id).eq('family_id', input.familyId).eq('tool_name', TOOL).eq('actor_kind', 'system')
        .eq('resource_table', 'guardian_communications').eq('resource_id', pointer).eq('state', 'reserved').eq('attempt', 0)
        .is('requested_by', null).is('requested_by_member_id', null).is('run_id', null).is('plan_step_id', null)
        .is('request_id', null).is('conversation_id', null).is('message_id', null).is('locked_at', null)
        .is('duration_ms', null).is('error', null).is('finished_at', null)
        .contains('outputs', { version: 1, phase: 'captured', revision: current.revision, decision: null })
        .select('id').retry(false).abortSignal(signal));
    } catch { /* Reconcile a lost response; never replace a competing decision. */ }
    const saved = await read(client, input, signal);
    if (!saved || saved.communicationId !== pointer || !sameDecision(saved.decision, nextDecision)) return unavailable();
    return saved;
  });
}

const COMM_COLUMNS = `id,family_id,member_id,comm_type,direction,from_number,to_number,body,twilio_sms_sid,${Object.keys(decisionSchema.shape).join(',')}`;
function onlyRow(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable();
  const result = raw as { data: unknown; error: unknown; count: number | null };
  if (result.error || result.count !== 1 || !Array.isArray(result.data) || result.data.length !== 1
    || !result.data[0] || typeof result.data[0] !== 'object' || Array.isArray(result.data[0])) return unavailable();
  return result.data[0] as Record<string, unknown>;
}

/** Completion follows the processed callback, never merely a saved decision. */
async function verifyCompletion(client: Client, receipt: GuardianSmsReceipt, signal: AbortSignal): Promise<void> {
  const { input, communicationId, decision } = receipt;
  if (!decision) return unavailable();
  const [communication, callback] = await Promise.all([
    request(signal, () => withGuardianTables(client).from('guardian_communications').select(COMM_COLUMNS, { count: 'exact' })
      .eq('id', communicationId).eq('family_id', input.familyId).limit(2).retry(false).abortSignal(signal)),
    request(signal, () => client.from('guardian_callback_events').select('event_id,callback_type,status,error,received_at,processed_at', { count: 'exact' })
      .eq('event_id', input.smsSid).limit(2).retry(false).abortSignal(signal)),
  ]);
  const comm = onlyRow(communication), event = onlyRow(callback);
  if (comm.id !== communicationId || comm.family_id !== input.familyId || comm.member_id !== input.memberId
    || comm.comm_type !== 'sms_inbound' || comm.direction !== 'inbound' || comm.from_number !== input.from
    || comm.to_number !== input.to || comm.body !== input.body || comm.twilio_sms_sid !== input.smsSid
    || !sameDecision(comm as GuardianSmsDecision, decision)
    || event.event_id !== input.smsSid || event.callback_type !== 'inbound_sms' || event.status !== 'processed'
    || event.error !== null || !timestamp(event.received_at) || !timestamp(event.processed_at)) return unavailable();
  const blocked = decision.status === 'blocked' || decision.routing_mode_used === 'blocked'
    || decision.scam_detected && decision.scam_confidence >= 80;
  if (blocked) return;
  // Query the relation, not only the deterministic ID: an existing matching
  // notification from before recovery must not cause a second family alert.
  const notification = onlyRow(await request(signal, () => client.from('notifications')
    .select('id,family_id,user_id,type,title,body,related_type,related_id', { count: 'exact' })
    .eq('family_id', input.familyId).eq('related_type', 'guardian_communications').eq('related_id', communicationId)
    .limit(2).retry(false).abortSignal(signal)));
  const preview = input.body.length > 100 ? `${input.body.slice(0, 100)}…` : input.body;
  if (!uuid.safeParse(notification.id).success || notification.family_id !== input.familyId || notification.user_id !== null
    || notification.type !== 'system' || notification.title !== `💬 Text from ${decision.from_name ?? formatPhone(input.from)}`.trim()
    || notification.body !== (preview.trim() || null) || notification.related_type !== 'guardian_communications'
    || notification.related_id !== communicationId) return unavailable();
}

/** Verify every required durable effect, then preserve the decision in a terminal receipt. */
export function markGuardianSmsCompleted(client: Client, receipt: GuardianSmsReceipt, options?: Options): Promise<GuardianSmsReceipt> {
  return bounded(options, async signal => {
    const input = inputSchema.parse(receipt.input), pointer = uuid.parse(receipt.communicationId);
    const decision = decisionSchema.parse(receipt.decision), expected = identity(input.smsSid);
    if (receipt.id !== expected.id || !uuid.safeParse(receipt.revision).success
      || !['decided', 'completed'].includes(receipt.phase)
      || (receipt.phase === 'decided' ? receipt.completedAt !== null : !timestamp(receipt.completedAt))) return unavailable();
    const current = await read(client, input, signal);
    if (!current || current.communicationId !== pointer || !sameDecision(current.decision, decision)) return unavailable();
    if (current.phase === 'completed') {
      if (receipt.phase === 'completed' && (receipt.revision !== current.revision || receipt.completedAt !== current.completedAt)) return unavailable();
      await verifyCompletion(client, current, signal);
      return current;
    }
    if (current.phase !== 'decided' || receipt.phase !== 'decided' || current.revision !== receipt.revision) return unavailable();
    await verifyCompletion(client, current, signal);
    try {
      await request(signal, () => client.from('ai_tool_calls').update({
        outputs: { version: 1, revision: randomUUID(), phase: 'completed', decision, completedAt: new Date().toISOString() },
      }).eq('id', expected.id).eq('family_id', input.familyId).eq('tool_name', TOOL).eq('actor_kind', 'system')
        .eq('resource_table', 'guardian_communications').eq('resource_id', pointer).eq('state', 'succeeded').eq('attempt', 1)
        .eq('idempotency_key', expected.key)
        .is('requested_by', null).is('requested_by_member_id', null).is('run_id', null).is('plan_step_id', null)
        .is('request_id', null).is('conversation_id', null).is('message_id', null).is('locked_at', null)
        .is('duration_ms', null).is('error', null)
        .contains('outputs', { version: 1, phase: 'decided', revision: current.revision })
        .select('id').retry(false).abortSignal(signal));
    } catch { /* Reconcile a committed terminal transition after a lost response. */ }
    const saved = await read(client, input, signal);
    if (!saved || saved.communicationId !== pointer || saved.phase !== 'completed' || !sameDecision(saved.decision, decision)) return unavailable();
    return saved;
  });
}
