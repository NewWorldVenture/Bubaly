import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

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
]);
const NULL_METADATA = ['requested_by', 'requested_by_member_id', 'run_id', 'plan_step_id', 'request_id', 'conversation_id', 'message_id', 'locked_at', 'duration_ms', 'error'] as const;
const COLUMNS = 'id,family_id,tool_name,actor_kind,requested_by,requested_by_member_id,run_id,plan_step_id,request_id,conversation_id,message_id,inputs,outputs,state,attempt,locked_at,duration_ms,error,idempotency_key,resource_table,resource_id,finished_at,created_at,updated_at';
export type GuardianSmsReceiptInput = z.infer<typeof inputSchema>;
export type GuardianSmsDecision = z.infer<typeof decisionSchema>;
export type GuardianSmsReceipt = {
  id: string; revision: string; input: GuardianSmsReceiptInput; communicationId: string; decision: GuardianSmsDecision | null;
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
  return { id: expected.id, revision: output.revision, input, communicationId: stored.communicationId, decision: output.decision };
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
  const result = await request(signal, () => client.from('ai_tool_calls').select(COLUMNS, { count: 'exact' })
    .eq('id', identity(input.smsSid).id).limit(2).retry(false).abortSignal(signal));
  if (result.error || !Array.isArray(result.data) || result.count !== result.data.length || result.data.length > 1) return unavailable();
  return result.data.length ? validate(result.data[0], input) : null;
}

/** Read authorship from the service-writable ledger, never from a communication row. */
export function readGuardianSmsReceipt(client: Client, input: GuardianSmsReceiptInput, options?: Options): Promise<GuardianSmsReceipt | null> {
  return bounded(options, signal => read(client, inputSchema.parse(input), signal));
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
