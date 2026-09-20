import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { escapeLike } from '@/lib/supabase/escape-like';
import { safeContactText } from './text';
import { SMS_REPLY_COLUMNS, validateSmsReplyReceipt, type SmsReplyReceipt } from './sms-reply';
import { validateUrgentDeliveryReceipt } from './urgent-delivery';

type Admin = SupabaseClient<Database>;
type Options = { signal?: AbortSignal };
const TOOL = 'contact_center.sms_ingress';
const REQUEST_MS = 5000;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const sid = z.string().regex(/^(SM|MM)[0-9a-f]{32}$/i);
const account = z.string().regex(/^AC[0-9a-f]{32}$/i);
const timestamp = z.string().datetime({ offset: true });
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const sender = z.string().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/)
  .refine(value => safeContactText(value, value.length) === value).nullable();
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const envelopeSchema = z.object({ smsSid: sid, accountSid: account.nullable(), from: sender, to: phone,
  body: z.string().max(64 * 1024) }).strict();
const captureSchema = envelopeSchema.extend({ familyId: uuid, channelId: uuid }).strict()
  .refine(value => value.familyId.toLowerCase() === value.channelId.toLowerCase());
const bindingSchema = z.object({ familyId: uuid, channelId: uuid, smsSid: sid, from: sender, to: phone,
  body: z.string().max(4096).refine(value => safeContactText(value, 4096) === value) }).strict()
  .refine(value => value.familyId === value.channelId);
const inputsSchema = z.object({ version: z.literal(1), normalizationVersion: z.literal(1), binding: bindingSchema,
  accountSid: account.nullable(), bodyDigest: digest, fingerprint: digest }).strict();
const outputsSchema = z.object({ version: z.literal(1), phase: z.literal('captured'), capturedAt: timestamp }).strict();
const NULL_METADATA = ['requested_by', 'requested_by_member_id', 'run_id', 'plan_step_id', 'request_id',
  'conversation_id', 'message_id', 'locked_at', 'duration_ms', 'error', 'resource_table', 'resource_id'] as const;
const COLUMNS = 'id,family_id,tool_name,actor_kind,requested_by,requested_by_member_id,run_id,plan_step_id,request_id,conversation_id,message_id,inputs,outputs,state,attempt,locked_at,duration_ms,error,idempotency_key,resource_table,resource_id,finished_at,created_at,updated_at';
const COLUMN_NAMES = new Set(COLUMNS.split(','));

/** body is the original decoded form value, before normalization or truncation. */
export type SmsIngressEnvelope = z.infer<typeof envelopeSchema>;
export type SmsIngressCapture = z.infer<typeof captureSchema>;
export type SmsIngressReceipt = {
  id: string; binding: z.infer<typeof bindingSchema>; accountSid: string | null; bodyDigest: string; capturedAt: string;
};
export class SmsIngressUnavailableError extends Error {
  constructor() { super('SMS ingress unavailable'); this.name = 'SmsIngressUnavailableError'; }
}
function unavailable(): never { throw new SmsIngressUnavailableError(); }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const providerId = (value: string) => `${value.slice(0, 2).toUpperCase()}${value.slice(2).toLowerCase()}`;
function identity(smsSid: string) {
  const key = `${TOOL}:v1:${sid.parse(smsSid).toLowerCase()}`, hex = hash(key);
  return { key, id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}` };
}
export function smsIngressReceiptId(smsSid: string): string { return identity(smsSid).id; }
function envelope(input: SmsIngressEnvelope) {
  const parsed = envelopeSchema.parse(input);
  return { smsSid: providerId(parsed.smsSid), accountSid: parsed.accountSid === null ? null : providerId(parsed.accountSid),
    from: parsed.from, to: parsed.to, body: safeContactText(parsed.body, 4096), bodyDigest: hash(JSON.stringify(parsed.body)) };
}
type Envelope = ReturnType<typeof envelope>;
function fingerprint(binding: SmsIngressReceipt['binding'], accountSid: string | null, bodyDigest: string): string {
  return hash(JSON.stringify({ normalizationVersion: 1, binding, accountSid, bodyDigest }));
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}
function validate(value: unknown, expected: Envelope): SmsIngressReceipt {
  const row = record(value), inputs = inputsSchema.parse(row.inputs), outputs = outputsSchema.parse(row.outputs);
  const wanted = identity(expected.smsSid), binding = inputs.binding;
  if (Object.keys(row).some(key => !COLUMN_NAMES.has(key)) || COLUMN_NAMES.size !== Object.keys(row).length
    || row.id !== wanted.id || row.idempotency_key !== wanted.key || row.family_id !== binding.familyId
    || row.tool_name !== TOOL || row.actor_kind !== 'system' || row.state !== 'succeeded' || row.attempt !== 1
    || NULL_METADATA.some(key => row[key] !== null)
    || binding.familyId !== binding.familyId.toLowerCase() || binding.channelId !== binding.channelId.toLowerCase()
    || binding.smsSid !== expected.smsSid || inputs.accountSid !== expected.accountSid
    || binding.from !== expected.from || binding.to !== expected.to || binding.body !== expected.body
    || inputs.bodyDigest !== expected.bodyDigest
    || inputs.fingerprint !== fingerprint(binding, inputs.accountSid, inputs.bodyDigest)) return unavailable();
  for (const key of ['created_at', 'updated_at', 'finished_at']) {
    if (!timestamp.safeParse(row[key]).success) return unavailable();
  }
  // Creation/update timestamps are database-managed; the immutable finish receipt
  // uses the captured application timestamp and need not share the database clock.
  if (Date.parse(String(row.created_at)) !== Date.parse(String(row.updated_at))
    || Date.parse(String(row.finished_at)) !== Date.parse(outputs.capturedAt)) return unavailable();
  return { id: wanted.id, binding, accountSid: inputs.accountSid, bodyDigest: inputs.bodyDigest, capturedAt: outputs.capturedAt };
}

/** One deadline includes read, insert and reconciliation, even if fetch ignores abort. */
async function operation<T>(options: Options | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(), parent = options?.signal;
  const abort = () => controller.abort();
  const timer = setTimeout(abort, REQUEST_MS);
  parent?.addEventListener('abort', abort, { once: true });
  let rejectOnAbort = () => {};
  try {
    if (parent?.aborted) abort();
    controller.signal.throwIfAborted();
    const interrupted = new Promise<never>((_, reject) => {
      rejectOnAbort = () => reject(new SmsIngressUnavailableError());
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    const result = await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted(); return run(controller.signal);
    }), interrupted]);
    controller.signal.throwIfAborted(); return result;
  } catch { return unavailable(); }
  finally {
    clearTimeout(timer); parent?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}
async function read(admin: Admin, expected: Envelope, signal: AbortSignal): Promise<SmsIngressReceipt | null> {
  signal.throwIfAborted();
  const result = await admin.from('ai_tool_calls').select(COLUMNS, { count: 'exact' })
    .eq('id', identity(expected.smsSid).id).limit(2).retry(false).abortSignal(signal);
  signal.throwIfAborted();
  if (result.error !== null || !Array.isArray(result.data) || result.count !== result.data.length || result.data.length > 1) return unavailable();
  return result.data.length ? validate(result.data[0], expected) : null;
}

/** Call only after signature verification. This never selects a replacement household. */
export async function readSmsIngress(admin: Admin, input: SmsIngressEnvelope, options?: Options): Promise<SmsIngressReceipt | null> {
  try {
    const expected = envelope(input);
    return await operation(options, signal => read(admin, expected, signal));
  } catch { return unavailable(); }
}

/** Old reply records have no original-body digest. Return them without inventing one. */
export async function readLegacySmsReplyForIngress(admin: Admin, input: SmsIngressEnvelope, options?: Options): Promise<SmsReplyReceipt | null> {
  try {
    const expected = envelope(input);
    return await operation(options, async signal => {
      signal.throwIfAborted();
      const result = await admin.from('ai_tool_calls').select(SMS_REPLY_COLUMNS, { count: 'exact' })
        .eq('tool_name', 'contact_center.sms_reply').ilike('inputs->binding->>smsSid', escapeLike(expected.smsSid))
        .limit(2).retry(false).abortSignal(signal);
      signal.throwIfAborted();
      if (result.error !== null || !Array.isArray(result.data) || result.count !== result.data.length || result.data.length > 1) return unavailable();
      if (!result.data.length) return null;
      const receipt = validateSmsReplyReceipt(result.data[0]), binding = receipt.binding;
      if (providerId(binding.smsSid) !== expected.smsSid || binding.from !== expected.from || binding.to !== expected.to
        || binding.body !== expected.body || receipt.emissionAccountSid !== null && providerId(receipt.emissionAccountSid) !== expected.accountSid) return unavailable();
      return receipt;
    });
  } catch { return unavailable(); }
}

/** Recovery context only; the caller must restore old intake before considering reply state. */
export async function readLegacyUrgentForIngress(admin: Admin, input: SmsIngressEnvelope, options?: Options): Promise<ReturnType<typeof validateUrgentDeliveryReceipt> | null> {
  try {
    const expected = envelope(input);
    return await operation(options, async signal => {
      signal.throwIfAborted();
      const result = await admin.from('ai_tool_calls').select(COLUMNS, { count: 'exact' })
        .eq('tool_name', 'contact_center.urgent_delivery').eq('inputs->>channel', 'sms')
        .ilike('inputs->>providerRef', escapeLike(expected.smsSid)).limit(2).retry(false).abortSignal(signal);
      signal.throwIfAborted();
      if (result.error !== null || !Array.isArray(result.data) || result.count !== result.data.length || result.data.length > 1) return unavailable();
      if (!result.data.length) return null;
      const row = result.data[0];
      if (!uuid.safeParse(row.family_id).success || Object.keys(row).some(key => !COLUMN_NAMES.has(key))
        || Object.keys(row).length !== COLUMN_NAMES.size) return unavailable();
      const receipt = validateUrgentDeliveryReceipt(row, row.family_id), saved = receipt.inputs;
      if (saved.channel !== 'sms' || !sid.safeParse(saved.providerRef).success || providerId(saved.providerRef) !== expected.smsSid
        || saved.from !== expected.from || saved.to !== expected.to || saved.subject !== null || saved.body !== expected.body) return unavailable();
      return receipt;
    });
  } catch { return unavailable(); }
}

/** Capture needs verified destination ownership. Existing legacy reply history is a caller check. */
export async function captureSmsIngress(admin: Admin, input: SmsIngressCapture, options?: Options): Promise<SmsIngressReceipt> {
  try {
    // Capture caller values before the first asynchronous operation.
    const parsed = captureSchema.parse(input), { familyId, channelId, ...incoming } = parsed;
    const expected = envelope(incoming), family = familyId.toLowerCase(), channel = channelId.toLowerCase();
    return await operation(options, async signal => {
      const existing = await read(admin, expected, signal);
      if (existing) {
        if (existing.binding.familyId !== family || existing.binding.channelId !== channel) return unavailable();
        return existing;
      }
      const wanted = identity(expected.smsSid), { accountSid, bodyDigest, ...boundEnvelope } = expected;
      const binding = { familyId: family, channelId: channel, ...boundEnvelope };
      const capturedAt = new Date().toISOString();
      const payload = {
        id: wanted.id, family_id: family, tool_name: TOOL, actor_kind: 'system', idempotency_key: wanted.key,
        requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null, request_id: null, conversation_id: null, message_id: null,
        inputs: { version: 1, normalizationVersion: 1, binding, accountSid, bodyDigest, fingerprint: fingerprint(binding, accountSid, bodyDigest) },
        outputs: { version: 1, phase: 'captured', capturedAt }, state: 'succeeded', attempt: 1,
        locked_at: null, duration_ms: null, error: null, resource_table: null, resource_id: null,
        finished_at: capturedAt,
      } satisfies Database['public']['Tables']['ai_tool_calls']['Insert'];
      // An insert is the only mutation. Neither a conflict nor readback grants emission.
      try {
        signal.throwIfAborted();
        await admin.from('ai_tool_calls').insert(payload, { count: 'exact' }).select(COLUMNS).retry(false).abortSignal(signal);
      } catch { /* A lost response or concurrent insert is resolved by fresh readback. */ }
      signal.throwIfAborted();
      const saved = await read(admin, expected, signal);
      if (!saved || saved.binding.familyId !== family || saved.binding.channelId !== channel) return unavailable();
      return saved;
    });
  } catch { return unavailable(); }
}
