import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { InboundIntent } from './routing';

type Admin = SupabaseClient<Database>;
type Options = { signal?: AbortSignal };
const TOOL = 'contact_center.sms_reply';
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)));
const sid = z.string().regex(/^(SM|MM)[0-9a-f]{32}$/i);
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const intent = z.enum(['urgent', 'appointment', 'delivery', 'sales', 'spam', 'personal', 'school', 'sports', 'other']);
const suppression = z.enum(['disabled', 'spam', 'unsupported_recipient']);
const bindingSchema = z.object({
  familyId: uuid, channelId: uuid, smsSid: sid,
  from: z.string().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/).nullable(),
  to: phone, body: z.string().max(4096),
}).strict().refine(value => value.channelId === value.familyId);
function xmlText(value: string): boolean {
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (!(point === 9 || point === 10 || point === 13 || point >= 32 && point <= 0xd7ff
      || point >= 0xe000 && point <= 0xfffd || point >= 0x10000 && point <= 0x10ffff)) return false;
  }
  return true;
}
const candidateSchema = z.object({
  summary: z.string().max(1000), intent,
  reply: z.string().min(1).max(4096).refine(value => !!value.trim() && xmlText(value)).nullable(),
  locale: z.string().min(2).max(40).regex(/^[a-zA-Z0-9-]+$/), suppression: suppression.nullable(),
}).strict();
const inputsSchema = z.object({ version: z.literal(1), policyVersion: z.literal(1), binding: bindingSchema, candidate: candidateSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const outputsSchema = z.object({
  version: z.literal(1), revision: uuid, phase: z.enum(['queued', 'emission_reserved', 'suppressed', 'legacy_unknown']),
  inboundId: uuid.nullable(), outboundId: uuid.nullable(), emissionToken: uuid.nullable(), emissionReservedAt: timestamp.nullable(),
  reason: z.enum(['disabled', 'spam', 'unsupported_recipient', 'reassigned', 'legacy']).nullable(),
}).strict();
type Inputs = z.infer<typeof inputsSchema>;
type Outputs = z.infer<typeof outputsSchema>;
export type SmsReplyBinding = z.infer<typeof bindingSchema>;
export type SmsReplyCandidate = Omit<z.infer<typeof candidateSchema>, 'intent'> & { intent: InboundIntent };
export type SmsReplyReceipt = Omit<Outputs, 'version'> & { id: string; binding: SmsReplyBinding; candidate: SmsReplyCandidate };
export const SMS_REPLY_COLUMNS = 'id,family_id,tool_name,actor_kind,requested_by,requested_by_member_id,run_id,plan_step_id,request_id,conversation_id,message_id,inputs,outputs,state,attempt,locked_at,duration_ms,error,idempotency_key,resource_table,resource_id,finished_at,created_at,updated_at';
const NULL_METADATA = ['requested_by', 'requested_by_member_id', 'run_id', 'plan_step_id', 'request_id', 'conversation_id', 'message_id', 'duration_ms', 'error'] as const;
const INBOX_COLUMNS = 'id,family_id,channel,direction,from_addr,to_addr,subject,body,ai_summary,ai_intent,ai_handled,status,provider_ref,occurred_at';
export class SmsReplyUnavailableError extends Error {
  constructor() { super('SMS reply state unavailable'); this.name = 'SmsReplyUnavailableError'; }
}
function unavailable(): never { throw new SmsReplyUnavailableError(); }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function stableId(value: string): string {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function identity(familyId: string, smsSid: string) {
  const key = `${TOOL}:v1:${hash(JSON.stringify([uuid.parse(familyId), 'sms', sid.parse(smsSid).toLowerCase()]))}`;
  return { id: stableId(key), key };
}
export function smsReplyReceiptId(familyId: string, smsSid: string): string { return identity(familyId, smsSid).id; }
export function smsReplyOutboundId(receiptId: string): string { return stableId(`${TOOL}:outbound:${uuid.parse(receiptId)}`); }
export function smsReplyOutboundRef(receiptId: string): string { return `${TOOL}:outbound:${uuid.parse(receiptId)}`; }
const sameBinding = (a: SmsReplyBinding, b: SmsReplyBinding) => (Object.keys(a) as Array<keyof SmsReplyBinding>)
  .every(key => key === 'smsSid' ? a.smsSid.toLowerCase() === b.smsSid.toLowerCase() : a[key] === b[key]);
const sameCandidate = (a: SmsReplyCandidate, b: SmsReplyCandidate) => (Object.keys(a) as Array<keyof SmsReplyCandidate>).every(key => a[key] === b[key]);
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable();
  return raw as Record<string, unknown>;
}

/** Strict application-state validation; caller must still establish family access. */
export function validateSmsReplyReceipt(raw: unknown): SmsReplyReceipt {
  try {
    const row = record(raw), inputs = inputsSchema.parse(row.inputs), outputs = outputsSchema.parse(row.outputs);
    const expected = identity(inputs.binding.familyId, inputs.binding.smsSid);
    if (inputs.fingerprint !== hash(JSON.stringify({ binding: inputs.binding, candidate: inputs.candidate }))) return unavailable();
    const reserved = outputs.phase === 'emission_reserved', terminal = ['suppressed', 'legacy_unknown'].includes(outputs.phase);
    if (row.id !== expected.id || row.idempotency_key !== expected.key || row.family_id !== inputs.binding.familyId
      || row.tool_name !== TOOL || row.actor_kind !== 'system' || NULL_METADATA.some(key => row[key] !== null)
      || row.resource_table !== 'family_inbox_messages' || row.resource_id !== outputs.inboundId
      || row.state !== (terminal ? 'failed' : 'reserved') || row.attempt !== (reserved ? 1 : 0)
      || !timestamp.safeParse(row.created_at).success || !timestamp.safeParse(row.updated_at).success
      || (terminal ? !timestamp.safeParse(row.finished_at).success : row.finished_at !== null)
      || (outputs.emissionReservedAt === null ? row.locked_at !== null
        : !timestamp.safeParse(row.locked_at).success || Date.parse(String(row.locked_at)) !== Date.parse(outputs.emissionReservedAt))) return unavailable();
    if (reserved) {
      if (!outputs.inboundId || outputs.outboundId !== smsReplyOutboundId(expected.id) || !outputs.emissionToken
        || !outputs.emissionReservedAt || outputs.reason !== null || !inputs.candidate.reply || inputs.candidate.suppression !== null) return unavailable();
    } else if (outputs.outboundId !== null || outputs.emissionToken !== null || outputs.emissionReservedAt !== null) return unavailable();
    if (outputs.phase === 'queued' && (!inputs.candidate.reply || inputs.candidate.suppression !== null || outputs.reason !== null)) return unavailable();
    if (outputs.phase === 'suppressed' && (!outputs.reason || outputs.reason === 'legacy')) return unavailable();
    if (outputs.phase === 'legacy_unknown' && (outputs.reason !== 'legacy' || !outputs.inboundId || inputs.candidate.reply !== null || inputs.candidate.suppression !== null)) return unavailable();
    if (inputs.candidate.suppression !== null && (outputs.phase !== 'suppressed' || outputs.reason !== inputs.candidate.suppression || inputs.candidate.reply !== null)) return unavailable();
    if (inputs.candidate.intent === 'spam' && outputs.phase !== 'legacy_unknown' && (outputs.phase !== 'suppressed' || outputs.reason !== 'spam')) return unavailable();
    if (!phone.safeParse(inputs.binding.from).success && !['suppressed', 'legacy_unknown'].includes(outputs.phase)) return unavailable();
    return { id: expected.id, revision: outputs.revision, phase: outputs.phase, inboundId: outputs.inboundId, outboundId: outputs.outboundId,
      emissionToken: outputs.emissionToken, emissionReservedAt: outputs.emissionReservedAt, reason: outputs.reason,
      binding: inputs.binding, candidate: inputs.candidate };
  } catch { return unavailable(); }
}

/** A late SDK/factory result cannot continue into a later write. */
async function bounded<T>(parent: AbortSignal | undefined, run: (signal: AbortSignal) => PromiseLike<T>, ms = 5000): Promise<T> {
  const signal = AbortSignal.any([AbortSignal.timeout(ms), ...(parent ? [parent] : [])]);
  let abort = () => {};
  try {
    signal.throwIfAborted();
    const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new SmsReplyUnavailableError()); signal.addEventListener('abort', abort, { once: true }); });
    const value = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return run(signal); }), interrupted]);
    signal.throwIfAborted(); return value;
  } catch { return unavailable(); }
  finally { signal.removeEventListener('abort', abort); }
}
const operation = <T>(options: Options | undefined, run: (signal: AbortSignal) => Promise<T>) => bounded(options?.signal, run, 30_000);
function rows(raw: unknown): Record<string, unknown>[] {
  const result = record(raw);
  if (result.error || !Array.isArray(result.data) || result.count !== result.data.length || result.data.length > 1) return unavailable();
  return result.data.map(record);
}
async function read(admin: Admin, binding: SmsReplyBinding, signal: AbortSignal): Promise<SmsReplyReceipt | null> {
  const expected = identity(binding.familyId, binding.smsSid);
  const found = rows(await bounded(signal, current => admin.from('ai_tool_calls').select(SMS_REPLY_COLUMNS, { count: 'exact' })
    .eq('id', expected.id).limit(2).retry(false).abortSignal(current)));
  if (!found.length) return null;
  const receipt = validateSmsReplyReceipt(found[0]);
  if (!sameBinding(receipt.binding, binding)) return unavailable();
  return receipt;
}
export function readSmsReply(admin: Admin, binding: SmsReplyBinding, options?: Options): Promise<SmsReplyReceipt | null> {
  return operation(options, signal => read(admin, bindingSchema.parse(binding), signal));
}
async function inbound(admin: Admin, binding: SmsReplyBinding, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  const found = rows(await bounded(signal, current => admin.from('family_inbox_messages').select(INBOX_COLUMNS, { count: 'exact' })
    .eq('channel', 'sms').eq('provider_ref', binding.smsSid).limit(2).retry(false).abortSignal(current)));
  if (!found.length) return null;
  const row = found[0];
  if (!uuid.safeParse(row.id).success || row.family_id !== binding.familyId || row.channel !== 'sms' || row.direction !== 'inbound'
    || row.provider_ref !== binding.smsSid || row.from_addr !== binding.from || row.to_addr !== binding.to || row.body !== binding.body
    || row.subject !== null || typeof row.ai_handled !== 'boolean' || !['new', 'read', 'archived'].includes(String(row.status))
    || !timestamp.safeParse(row.occurred_at).success) return unavailable();
  return row;
}
function stored(receipt: SmsReplyReceipt): { inputs: Inputs; outputs: Outputs } {
  return { inputs: { version: 1, policyVersion: 1, binding: receipt.binding, candidate: receipt.candidate,
    fingerprint: hash(JSON.stringify({ binding: receipt.binding, candidate: receipt.candidate })) },
    outputs: { version: 1, revision: receipt.revision, phase: receipt.phase, inboundId: receipt.inboundId, outboundId: receipt.outboundId,
      emissionToken: receipt.emissionToken, emissionReservedAt: receipt.emissionReservedAt, reason: receipt.reason } };
}
async function currentReceipt(admin: Admin, receipt: SmsReplyReceipt, signal: AbortSignal): Promise<SmsReplyReceipt> {
  const current = await read(admin, bindingSchema.parse(receipt.binding), signal);
  if (!current || current.id !== receipt.id || !sameCandidate(current.candidate, candidateSchema.parse(receipt.candidate))) return unavailable();
  return current;
}

/** Freeze the first committed reply before intake; historical captures remain held. */
export function prepareSmsReply(admin: Admin, binding: SmsReplyBinding,
  candidateFactory: (signal: AbortSignal) => Promise<SmsReplyCandidate>, options?: Options): Promise<SmsReplyReceipt> {
  return operation(options, async signal => {
    binding = bindingSchema.parse(binding);
    const existing = await read(admin, binding, signal);
    if (existing) return existing;
    const legacy = await inbound(admin, binding, signal);
    let candidate: SmsReplyCandidate;
    if (legacy) {
      candidate = candidateSchema.parse({ summary: legacy.ai_summary ?? binding.body.slice(0, 1000), intent: legacy.ai_intent ?? 'other',
        reply: null, locale: 'und', suppression: null });
    } else {
      candidate = candidateSchema.parse(await bounded(signal, current => candidateFactory(current), 15_000));
      if (candidate.intent === 'spam') candidate = { ...candidate, reply: null, suppression: 'spam' };
      else if (!phone.safeParse(binding.from).success) candidate = { ...candidate, reply: null, suppression: 'unsupported_recipient' };
      if (candidate.suppression !== null && candidate.reply !== null || candidate.suppression === null && candidate.reply === null) return unavailable();
    }
    // A concurrent current-version winner is authoritative even if its capture
    // appeared while this candidate was being generated.
    const winner = await read(admin, binding, signal);
    if (winner) return winner;
    const captured = legacy ?? await inbound(admin, binding, signal);
    if (!legacy && captured) return unavailable(); // Unknown older writer: never guess unsent.
    const expected = identity(binding.familyId, binding.smsSid), now = new Date().toISOString();
    const terminal = !!legacy || candidate.suppression !== null;
    const receipt: SmsReplyReceipt = { id: expected.id, revision: randomUUID(), binding, candidate,
      phase: legacy ? 'legacy_unknown' : terminal ? 'suppressed' : 'queued', inboundId: legacy ? String(legacy.id) : null,
      outboundId: null, emissionToken: null, emissionReservedAt: null, reason: legacy ? 'legacy' : candidate.suppression };
    const payload = stored(receipt);
    let write: unknown;
    try {
      write = await bounded(signal, current => admin.from('ai_tool_calls').insert({
        id: expected.id, family_id: binding.familyId, tool_name: TOOL, idempotency_key: expected.key, actor_kind: 'system',
        requested_by: null, requested_by_member_id: null, run_id: null, plan_step_id: null, request_id: null, conversation_id: null, message_id: null,
        ...payload, state: terminal ? 'failed' : 'reserved', attempt: 0, resource_table: 'family_inbox_messages', resource_id: receipt.inboundId,
        locked_at: null, duration_ms: null, error: null, finished_at: terminal ? now : null,
      }).select('id').retry(false).abortSignal(current));
    } catch { /* Readback can recover a committed candidate, never emission. */ }
    if (write && record(write).error && record(record(write).error).code !== '23505' && record(write).status !== 0) return unavailable();
    const saved = await read(admin, binding, signal);
    if (!saved) return unavailable();
    return saved;
  });
}

/** Conditional metadata writes preserve the immutable candidate and exact revision. */
async function transition(admin: Admin, receipt: SmsReplyReceipt, next: SmsReplyReceipt, signal: AbortSignal,
  terminal: boolean): Promise<unknown> {
  const { inputs, outputs } = stored(receipt), wanted = stored(next).outputs;
  return bounded(signal, current => {
    let query = admin.from('ai_tool_calls').update({ outputs: wanted, resource_id: next.inboundId,
      state: terminal ? 'failed' : 'reserved', attempt: next.phase === 'emission_reserved' ? 1 : 0,
      locked_at: next.emissionReservedAt, finished_at: terminal ? new Date().toISOString() : null,
    }, { count: 'exact' }).eq('id', receipt.id).eq('family_id', receipt.binding.familyId).eq('tool_name', TOOL).eq('actor_kind', 'system')
      .eq('state', ['suppressed', 'legacy_unknown'].includes(receipt.phase) ? 'failed' : 'reserved')
      .eq('attempt', receipt.phase === 'emission_reserved' ? 1 : 0).eq('idempotency_key', identity(receipt.binding.familyId, receipt.binding.smsSid).key)
      .eq('resource_table', 'family_inbox_messages').eq('inputs->>fingerprint', inputs.fingerprint).eq('outputs', JSON.stringify(outputs));
    for (const key of NULL_METADATA) query = query.is(key, null);
    query = receipt.inboundId === null ? query.is('resource_id', null) : query.eq('resource_id', receipt.inboundId);
    query = receipt.emissionReservedAt === null ? query.is('locked_at', null) : query.eq('locked_at', receipt.emissionReservedAt);
    return query.select(SMS_REPLY_COLUMNS).retry(false).abortSignal(current);
  });
}
export function attachSmsReply(admin: Admin, receipt: SmsReplyReceipt, inboundId: string, options?: Options): Promise<SmsReplyReceipt> {
  return operation(options, async signal => {
    uuid.parse(inboundId);
    const current = await currentReceipt(admin, receipt, signal), message = await inbound(admin, current.binding, signal);
    if (!message || message.id !== inboundId || current.inboundId !== null && current.inboundId !== inboundId) return unavailable();
    if (current.inboundId === inboundId) return current;
    if (current.phase === 'emission_reserved' || current.phase === 'legacy_unknown') return unavailable();
    const next = { ...current, inboundId, revision: randomUUID() };
    try { await transition(admin, current, next, signal, current.phase === 'suppressed'); } catch { /* Reconcile attachment only. */ }
    const saved = await currentReceipt(admin, current, signal);
    if (saved.inboundId !== inboundId) return unavailable();
    return saved;
  });
}

async function channelSuppression(admin: Admin, receipt: SmsReplyReceipt, signal: AbortSignal): Promise<'disabled' | 'reassigned' | null> {
  const binding = receipt.binding;
  const found = rows(await bounded(signal, current => admin.from('family_contact_channels')
    .select('family_id,phone_number,ai_concierge_enabled', { count: 'exact' }).eq('phone_number', binding.to).limit(2).retry(false).abortSignal(current)));
  if (!found.length) return 'reassigned';
  const row = found[0];
  if (!uuid.safeParse(row.family_id).success || typeof row.ai_concierge_enabled !== 'boolean' || row.phone_number !== binding.to) return unavailable();
  if (row.family_id !== binding.familyId) return 'reassigned';
  return row.ai_concierge_enabled ? null : 'disabled';
}
async function projection(admin: Admin, receipt: SmsReplyReceipt, signal: AbortSignal): Promise<void> {
  const id = smsReplyOutboundId(receipt.id), providerRef = smsReplyOutboundRef(receipt.id);
  const readProjection = async () => {
    const found = rows(await bounded(signal, current => admin.from('family_inbox_messages').select(INBOX_COLUMNS, { count: 'exact' })
      .eq('id', id).limit(2).retry(false).abortSignal(current)));
    if (!found.length) return false;
    const row = found[0];
    if (row.id !== id || row.family_id !== receipt.binding.familyId || row.channel !== 'sms' || row.direction !== 'outbound'
      || row.from_addr !== receipt.binding.to || row.to_addr !== receipt.binding.from || row.body !== receipt.candidate.reply
      || row.provider_ref !== providerRef || row.subject !== null || row.ai_summary !== null || row.ai_intent !== null
      || row.ai_handled !== true || !['new', 'read', 'archived'].includes(String(row.status)) || !timestamp.safeParse(row.occurred_at).success) return unavailable();
    return true;
  };
  if (await readProjection()) return;
  try {
    await bounded(signal, current => admin.from('family_inbox_messages').insert({ id, family_id: receipt.binding.familyId,
      channel: 'sms', direction: 'outbound', from_addr: receipt.binding.to, to_addr: receipt.binding.from,
      body: receipt.candidate.reply!, provider_ref: providerRef, subject: null, ai_summary: null, ai_intent: null, ai_handled: true, status: 'read',
    }).select('id').retry(false).abortSignal(current));
  } catch { /* Projection identity does not authorize emission. */ }
  if (!await readProjection()) return unavailable();
}

/** Only an exact successful CAS response grants emission; readback never does. */
export function reserveSmsReply(admin: Admin, receipt: SmsReplyReceipt, options?: Options): Promise<{ receipt: SmsReplyReceipt; emission: string | null }> {
  return operation(options, async signal => {
    let current = await currentReceipt(admin, receipt, signal);
    const message = await inbound(admin, current.binding, signal);
    if (!message || message.id !== current.inboundId) return unavailable();
    if (current.phase !== 'queued') return { receipt: current, emission: null };
    const suppress = async (reason: 'disabled' | 'reassigned') => {
      const next: SmsReplyReceipt = { ...current, revision: randomUUID(), phase: 'suppressed', reason };
      try { await transition(admin, current, next, signal, true); } catch { /* No emission on an uncertain suppression. */ }
      const saved = await currentReceipt(admin, current, signal);
      if (saved.phase === 'queued') return unavailable();
      return { receipt: saved, emission: null };
    };
    const reason = await channelSuppression(admin, current, signal);
    if (reason) return suppress(reason);
    await projection(admin, current, signal);
    current = await currentReceipt(admin, current, signal);
    if (current.phase !== 'queued') return { receipt: current, emission: null };
    const finalMessage = await inbound(admin, current.binding, signal);
    if (!finalMessage || finalMessage.id !== current.inboundId) return unavailable();
    const changed = await channelSuppression(admin, current, signal);
    if (changed) return suppress(changed);
    const next: SmsReplyReceipt = { ...current, revision: randomUUID(), phase: 'emission_reserved',
      outboundId: smsReplyOutboundId(current.id), emissionToken: randomUUID(), emissionReservedAt: new Date().toISOString() };
    const changedRows = rows(await transition(admin, current, next, signal, false));
    if (!changedRows.length) return { receipt: current, emission: null };
    const saved = validateSmsReplyReceipt(changedRows[0]);
    if (JSON.stringify(saved) !== JSON.stringify(next)) return unavailable();
    return { receipt: saved, emission: saved.candidate.reply };
  });
}
