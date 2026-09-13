import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tables } from '@/lib/database.types';
import type { createServiceClient } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { isTwilioConfigured, sendSmsWithReceipt } from '@/lib/guardian/twilio';
import { findInboundMessage, inboundProviderRef, recordInboundMessage, type InboundRecord } from './server';
import { parseRecipientLocal } from './address';

type Admin = ReturnType<typeof createServiceClient>;
type Intake = Parameters<typeof recordInboundMessage>[1];
const TOOL = 'contact_center.urgent_delivery';
const PREFIX = `${TOOL}:`;
const CURSOR_KEY = `${PREFIX}cursor`;
const MAX_ATTEMPTS = 5;
/**
 * What a receipt will accept, EXPORTED so callers bound their input to the same
 * numbers instead of guessing them.
 *
 * The email route took its headers straight from the request and only sliced
 * `body`, so a long `To` threw a ZodError below, which nothing caught — the
 * message was answered 503 and never filed at all. Two places holding the same
 * limits privately is how that happens; there is now one place.
 */
export const MAX_PROVIDER_REF = 2048;
export const MAX_ADDRESS = 512;
export const MAX_SUBJECT = 1000;
export const MAX_BODY = 8000;
export const MAX_SUMMARY = 1000;

const inputSchema = z.object({
  version: z.literal(1), familyId: z.string().min(1).max(128), channel: z.enum(['sms', 'voice', 'email']),
  providerRef: z.string().min(1).max(MAX_PROVIDER_REF), from: z.string().max(MAX_ADDRESS).nullable(), to: z.string().max(MAX_ADDRESS).nullable(),
  subject: z.string().max(MAX_SUBJECT).nullable(), body: z.string().max(MAX_BODY), summary: z.string().max(MAX_SUMMARY), intent: z.literal('urgent'),
}).strict();
const outputSchema = z.object({
  version: z.literal(1), revision: z.string().uuid(),
  phase: z.enum(['queued', 'dispatching', 'accepted', 'unknown', 'rejected', 'legacy_unknown', 'in_app_only']),
  notificationDone: z.boolean(), drain: z.boolean(), retryAt: z.string().datetime().nullable(),
  destination: z.string().max(32).nullable(), providerSid: z.string().regex(/^(SM|MM)[0-9a-f]{32}$/i).nullable(),
  providerStatus: z.enum(['accepted', 'queued', 'sending', 'sent', 'delivered', 'read']).nullable(),
}).strict();
type Inputs = z.infer<typeof inputSchema>;
type Outputs = z.infer<typeof outputSchema>;
type Receipt = Omit<Tables<'ai_tool_calls'>, 'inputs' | 'outputs'> & { inputs: Inputs; outputs: Outputs };
export type UrgentOutcome = 'accepted' | 'in_app_only' | 'pending' | 'unknown' | 'rejected' | 'legacy_unknown' | 'failed';

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function uuid(value: string): string {
  const hex = digest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function identity(input: Pick<Inputs, 'familyId' | 'channel' | 'providerRef'>) {
  const key = `${PREFIX}${digest(JSON.stringify([input.familyId, input.channel, input.providerRef]))}`;
  return { id: uuid(key), key };
}
function validate(row: Tables<'ai_tool_calls'>, familyId: string): Receipt {
  const inputs = inputSchema.parse(row.inputs), outputs = outputSchema.parse(row.outputs);
  const expected = identity(inputs);
  if (row.id !== expected.id || row.idempotency_key !== expected.key || row.family_id !== familyId || inputs.familyId !== familyId ||
      row.tool_name !== TOOL || row.actor_kind !== 'system' ||
      [row.requested_by, row.requested_by_member_id, row.run_id, row.plan_step_id, row.request_id, row.conversation_id, row.message_id].some(value => value !== null) ||
      !Number.isInteger(row.attempt) || row.attempt < 0 || row.attempt > MAX_ATTEMPTS ||
      (row.resource_table !== null && row.resource_table !== 'family_inbox_messages')) throw new Error('Urgent receipt identity invalid');
  return { ...row, inputs, outputs };
}
async function readReceipt(admin: Admin, id: string, familyId: string, signal?: AbortSignal): Promise<Receipt | null> {
  const result = await admin.from('ai_tool_calls').select('*').eq('id', id).abortSignal(signal ?? AbortSignal.timeout(5000)).maybeSingle();
  if (result.error) throw new Error('Urgent receipt read failed');
  return result.data ? validate(result.data, familyId) : null;
}
function asIntake(input: Inputs): Intake {
  return { familyId: input.familyId, channel: input.channel, providerRef: input.providerRef, from: input.from ?? undefined,
    to: input.to ?? undefined, subject: input.subject ?? undefined, body: input.body, aiSummary: input.summary, aiIntent: input.intent };
}

/** Persist all recovery inputs before capture. Historical inbox rows are never guessed unsent. */
export async function captureInboundWithUrgency(admin: Admin, input: Intake): Promise<InboundRecord & { urgentReceiptId?: string }> {
  const providerRef = inboundProviderRef(input), expected = identity({ ...input, providerRef });
  let receipt = await readReceipt(admin, expected.id, input.familyId);
  if (!receipt && input.aiIntent !== 'urgent') return recordInboundMessage(admin, { ...input, providerRef });
  if (!receipt) {
    const inputs = inputSchema.parse({ version: 1, familyId: input.familyId, channel: input.channel, providerRef,
      from: input.from ?? null, to: input.to ?? null, subject: input.subject ?? null, body: input.body,
      summary: (input.aiSummary ?? input.body).slice(0, 1000), intent: 'urgent' });
    const existing = await findInboundMessage(admin, { ...input, providerRef });
    const outputs: Outputs = { version: 1, revision: randomUUID(), phase: existing ? 'legacy_unknown' : 'queued',
      notificationDone: false, drain: !existing, retryAt: null, destination: null, providerSid: null, providerStatus: null };
    const t = await getTranslations();
    const saved = await admin.from('ai_tool_calls').insert({ id: expected.id, family_id: input.familyId, tool_name: TOOL,
      idempotency_key: expected.key, actor_kind: 'system', requested_by: null, requested_by_member_id: null,
      run_id: null, plan_step_id: null, request_id: null, conversation_id: null, message_id: null,
      inputs, outputs, state: existing ? 'failed' : 'reserved', attempt: 0,
      resource_table: 'family_inbox_messages', resource_id: existing,
      error: existing ? t('contactUrgent.legacyUnknown') : null,
    }).select('id').abortSignal(AbortSignal.timeout(5000));
    if (saved.error && saved.error.code !== '23505') throw new Error('Urgent receipt persistence failed');
    receipt = await readReceipt(admin, expected.id, input.familyId);
    if (!receipt) throw new Error('Urgent receipt persistence unconfirmed');
  }
  const filed = await recordInboundMessage(admin, asIntake(receipt.inputs));
  return { ...filed, urgentReceiptId: receipt.id };
}

/** Every write after an await is fenced by the exact revision this worker observed. */
async function transition(admin: Admin, receipt: Receipt, outputs: Outputs, options: {
  state?: Receipt['state']; resourceId?: string; attempt?: number; error?: string | null;
}, signal: AbortSignal): Promise<Receipt | null> {
  const next = { ...outputs, revision: randomUUID() };
  const t = await getTranslations();
  const result = await admin.from('ai_tool_calls').update({ outputs: next, state: options.state ?? receipt.state,
    resource_id: options.resourceId ?? receipt.resource_id, attempt: options.attempt ?? receipt.attempt,
    error: options.error === undefined ? receipt.error : options.error === null ? null : t(options.error),
    locked_at: next.phase === 'dispatching' ? new Date().toISOString() : receipt.locked_at,
    finished_at: next.drain ? null : new Date().toISOString(),
  }).eq('id', receipt.id).eq('family_id', receipt.family_id).eq('tool_name', TOOL)
    .eq('state', receipt.state).contains('outputs', { revision: receipt.outputs.revision })
    .abortSignal(signal).select('*').maybeSingle();
  if (result.error) throw new Error('Urgent receipt update failed');
  return result.data ? validate(result.data, receipt.family_id) : null;
}

async function ensureNotification(admin: Admin, receipt: Receipt, messageId: string, signal: AbortSignal): Promise<void> {
  const t = await getTranslations(), id = uuid(`${receipt.id}:in_app`);
  const saved = await admin.from('notifications').upsert({ id, family_id: receipt.family_id, user_id: null,
    type: 'system', title: t('contactUrgent.alertTitle'), body: receipt.inputs.summary,
    related_type: 'contact_center', related_id: messageId,
  }, { onConflict: 'id', ignoreDuplicates: true }).abortSignal(signal);
  if (saved.error) throw new Error('Urgent notification write failed');
  const found = await admin.from('notifications').select('id,family_id,user_id,related_type,related_id')
    .eq('id', id).abortSignal(signal).maybeSingle();
  if (found.error || !found.data || found.data.family_id !== receipt.family_id || found.data.user_id !== null ||
      found.data.related_type !== 'contact_center' || found.data.related_id !== messageId) throw new Error('Urgent notification identity invalid');
}

/** Durable capture succeeds independently from provider availability; callers still run planner recovery. */
export async function attemptUrgentDelivery(admin: Admin, id: string, familyId: string, options: { now?: Date; signal?: AbortSignal } = {}): Promise<UrgentOutcome> {
  const signal = options.signal ?? AbortSignal.timeout(25_000), now = options.now ?? new Date();
  try {
    let receipt = await readReceipt(admin, id, familyId, signal);
    if (!receipt) return 'failed';
    if (receipt.outputs.phase === 'legacy_unknown') return 'legacy_unknown';
    const filed = await recordInboundMessage(admin, asIntake(receipt.inputs), signal);
    if (!filed.messageId || (receipt.resource_id && receipt.resource_id !== filed.messageId)) return 'failed';
    let notificationDone = receipt.outputs.notificationDone;
    if (!notificationDone) {
      try { await ensureNotification(admin, receipt, filed.messageId, signal); notificationDone = true; }
      catch { console.error('[contact-center] urgent notification needs recovery'); }
    }
    // A concurrent repair must never invalidate the revision held by an external send.
    if (receipt.outputs.phase === 'dispatching') return notificationDone ? 'unknown' : 'failed';
    if (receipt.outputs.phase !== 'queued') {
      if (notificationDone !== receipt.outputs.notificationDone) {
        const state = notificationDone && ['accepted', 'in_app_only'].includes(receipt.outputs.phase) ? 'succeeded' : receipt.state;
        const next = await transition(admin, receipt, { ...receipt.outputs, notificationDone, drain: !notificationDone }, { state }, signal);
        if (!next) return 'pending';
      }
      return notificationDone ? receipt.outputs.phase : 'failed';
    }
    if (notificationDone !== receipt.outputs.notificationDone || receipt.resource_id !== filed.messageId) {
      const next = await transition(admin, receipt, { ...receipt.outputs, notificationDone }, { resourceId: filed.messageId }, signal);
      if (!next) return 'pending';
      receipt = next;
    }
    if (receipt.outputs.retryAt && Date.parse(receipt.outputs.retryAt) > now.getTime()) return 'pending';
    // The stored routing snapshot is recovery context, never perpetual authority.
    const [family, channel] = await Promise.all([
      admin.from('families').select('id').eq('id', familyId).abortSignal(signal).maybeSingle(),
      admin.from('family_contact_channels').select('family_id,phone_number,email_local,forward_to_phone')
        .eq('family_id', familyId).abortSignal(signal).maybeSingle(),
    ]);
    if (family.error || channel.error || !family.data || family.data.id !== familyId || !channel.data || channel.data.family_id !== familyId) return 'failed';
    const to = receipt.inputs.to;
    const recipientMatches = receipt.inputs.channel === 'email'
      ? !!channel.data.email_local && parseRecipientLocal(to) === channel.data.email_local.toLowerCase()
      : !!channel.data.phone_number && (!to || channel.data.phone_number === to);
    if (!recipientMatches) {
      await transition(admin, receipt, { ...receipt.outputs, phase: 'rejected', drain: !notificationDone }, { state: 'failed', error: 'contactUrgent.smsRejected' }, signal);
      return 'rejected';
    }
    if (!channel.data.forward_to_phone) {
      const done = await transition(admin, receipt, { ...receipt.outputs, phase: 'in_app_only', drain: !notificationDone }, { state: notificationDone ? 'succeeded' : 'reserved', error: null }, signal);
      return done && notificationDone ? 'in_app_only' : 'failed';
    }
    if (!isTwilioConfigured()) {
      await transition(admin, receipt, { ...receipt.outputs, retryAt: new Date(now.getTime() + 300_000).toISOString() }, { error: 'contactUrgent.smsUnavailable' }, signal);
      return 'pending';
    }
    if (receipt.attempt >= MAX_ATTEMPTS) return 'rejected';
    const t = await getTranslations();
    const body = t('contactUrgent.smsPrefix', { summary: receipt.inputs.summary });
    if (signal.aborted) return 'failed';
    const claimed = await transition(admin, receipt, { ...receipt.outputs, phase: 'dispatching', destination: channel.data.forward_to_phone,
      retryAt: null, drain: true }, { state: 'reserved', attempt: receipt.attempt + 1, error: 'contactUrgent.smsUnknown' }, signal);
    if (!claimed) return 'pending';
    const result = await sendSmsWithReceipt(channel.data.forward_to_phone, body, signal);
    let outputs: Outputs = { ...claimed.outputs, phase: 'unknown', drain: !notificationDone };
    let state: Receipt['state'] = 'reserved', error: string | null = 'contactUrgent.smsUnknown';
    if (result.kind === 'accepted') {
      outputs = { ...outputs, phase: 'accepted', providerSid: result.messageSid, providerStatus: result.providerStatus as Outputs['providerStatus'] };
      state = notificationDone ? 'succeeded' : 'reserved'; error = null;
    } else if ((result.kind === 'retryable' || result.kind === 'unconfigured') && claimed.attempt < MAX_ATTEMPTS) {
      outputs = { ...outputs, phase: 'queued', drain: true, retryAt: new Date(now.getTime() + Math.min(60, 2 ** claimed.attempt) * 60_000).toISOString() };
      state = 'failed'; error = 'contactUrgent.smsUnavailable';
    } else if (result.kind === 'rejected' || result.kind === 'retryable' || result.kind === 'unconfigured') {
      outputs = { ...outputs, phase: 'rejected' }; state = 'failed'; error = 'contactUrgent.smsRejected';
    }
    const finished = await transition(admin, claimed, outputs, { state, error }, signal);
    // Persistence loss deliberately leaves dispatching held; never infer a safe resend.
    if (!finished) return 'unknown';
    if (!notificationDone) return 'failed';
    return outputs.phase === 'queued' ? 'pending' : outputs.phase as UrgentOutcome;
  } catch {
    console.error('[contact-center] urgent delivery needs recovery');
    return 'failed';
  }
}

const cursorSchema = z.object({ id: z.string().uuid(), createdAt: z.string().datetime({ offset: true }) }).strict();
/** Fair bounded traversal, including poison/held rows, without altering intake timestamps. */
export async function drainUrgentDeliveries(admin: Admin, options: { limit?: number; now?: Date } = {}) {
  const limit = Math.min(20, Math.max(1, options.limit ?? 10)), started = Date.now();
  const counts = { examined: 0, accepted: 0, in_app_only: 0, pending: 0, unknown: 0, rejected: 0, legacy_unknown: 0, failed: 0 };
  const saved = await admin.from('app_settings').select('value').eq('key', CURSOR_KEY).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
  if (saved.error) throw new Error('Urgent cursor read failed');
  let cursor = saved.data ? cursorSchema.parse(saved.data.value) : null;
  let wrapped = false;
  const visited = new Set<string>();
  while (counts.examined < limit && Date.now() - started < 65_000) {
    let query = admin.from('ai_tool_calls').select('id,family_id,created_at').eq('tool_name', TOOL).contains('outputs', { drain: true })
      .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(1);
    if (cursor) query = query.or(`created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`);
    const batch = await query.abortSignal(AbortSignal.timeout(5000));
    if (batch.error || !Array.isArray(batch.data)) throw new Error('Urgent queue read failed');
    const row = batch.data[0];
    if (!row) { if (!cursor || wrapped) break; cursor = null; wrapped = true; continue; }
    if (visited.has(row.id)) break;
    cursor = cursorSchema.parse({ id: row.id, createdAt: row.created_at });
    visited.add(row.id);
    const outcome = await attemptUrgentDelivery(admin, row.id, row.family_id, { now: options.now });
    counts.examined += 1; counts[outcome] += 1;
    const stored = await admin.from('app_settings').upsert({ key: CURSOR_KEY, value: cursor }, { onConflict: 'key' })
      .abortSignal(AbortSignal.timeout(5000)).select('key').maybeSingle();
    if (stored.error || stored.data?.key !== CURSOR_KEY) throw new Error('Urgent cursor persistence failed');
  }
  return counts;
}
