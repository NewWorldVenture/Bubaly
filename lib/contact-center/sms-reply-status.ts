import 'server-only';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import type { Tables } from '@/lib/database.types';
import {
  SMS_REPLY_COLUMNS, smsReplyReceiptId, smsReplyOutboundId, smsReplyOutboundRef,
  validateSmsReplyReceipt, type SmsReplyReceipt,
} from './sms-reply';

export type SmsReplyStatus = 'prepared' | 'confirmation_unknown' | 'suppressed' | 'legacy_unknown' | 'unavailable'
  | 'provider_queued' | 'sending' | 'sent' | 'delivered' | 'undelivered' | 'failed';
type Message = Pick<Tables<'family_inbox_messages'>,
  'id' | 'channel' | 'direction' | 'from_addr' | 'to_addr' | 'subject' | 'body' | 'ai_summary' | 'ai_intent' | 'status' | 'occurred_at'>;
type Row = Record<string, unknown>;
const TOOL = 'contact_center.sms_reply';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SID = /^(SM|MM)[0-9a-f]{32}$/i;
const OUTBOUND_PREFIX = `${TOOL}:outbound:`;
const INBOX_COLUMNS = 'id,family_id,channel,direction,from_addr,to_addr,subject,body,ai_summary,ai_intent,ai_handled,status,provider_ref,occurred_at';
const DISPLAY_FIELDS = ['id', 'channel', 'direction', 'from_addr', 'to_addr', 'subject', 'body', 'ai_summary', 'ai_intent', 'status', 'occurred_at'] as const;
const fail = (): never => { throw new Error('SMS reply status unavailable'); };
function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Row;
}
function rows(value: unknown, ids: Set<string>): Row[] {
  const result = record(value);
  if (result.error || !Array.isArray(result.data) || result.count !== result.data.length || result.data.length > ids.size) return fail();
  const found = result.data.map(record);
  if (found.some(row => typeof row.id !== 'string' || !ids.has(row.id)) || new Set(found.map(row => row.id)).size !== found.length) return fail();
  return found;
}
async function bounded<T>(signal: AbortSignal, run: () => PromiseLike<T>): Promise<T> {
  let abort = () => {};
  try {
    signal.throwIfAborted();
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('SMS reply status unavailable'));
      signal.addEventListener('abort', abort, { once: true });
    });
    const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }), interrupted]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener('abort', abort); }
}
function inboundMatches(row: Row | undefined, receipt: SmsReplyReceipt): boolean {
  const { binding, candidate } = receipt;
  return !!row && row.id === receipt.inboundId && row.family_id === binding.familyId && row.channel === 'sms'
    && row.direction === 'inbound' && row.provider_ref === binding.smsSid && row.from_addr === binding.from
    && row.to_addr === binding.to && row.body === binding.body && row.subject === null
    && (receipt.phase === 'legacy_unknown' ? (row.ai_summary ?? binding.body.slice(0, 1000)) === candidate.summary
      && (row.ai_intent ?? 'other') === candidate.intent : row.ai_summary === candidate.summary && row.ai_intent === candidate.intent);
}
function outboundMatches(row: Row | undefined, receipt: SmsReplyReceipt): boolean {
  return !!row && !!receipt.candidate.reply && row.id === smsReplyOutboundId(receipt.id)
    && row.family_id === receipt.binding.familyId && row.channel === 'sms' && row.direction === 'outbound'
    && row.from_addr === receipt.binding.to && row.to_addr === receipt.binding.from && row.body === receipt.candidate.reply
    && row.provider_ref === smsReplyOutboundRef(receipt.id) && row.subject === null
    && row.ai_summary === null && row.ai_intent === null && row.ai_handled === true;
}

/** Display only: resolve authorization here; never accept a caller-selected household. */
export async function readSmsReplyStatuses(messages: readonly Message[]): Promise<Record<string, SmsReplyStatus>> {
  const sms = messages.filter(message => message.channel === 'sms');
  if (!sms.length) return {};
  const result: Record<string, SmsReplyStatus> = Object.fromEntries(sms.map(message => [message.id, 'unavailable']));
  const context = await requirePlanLevel(2);
  const familyId = context.active.familyId;
  if (messages.length > 100 || sms.some(message => !UUID.test(message.id)) || new Set(sms.map(message => message.id)).size !== sms.length) return result;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  const signal = controller.signal;
  try {
    const admin = createServiceClient();
    const readMessages = async (ids: Set<string>) => {
      if (!ids.size) return [];
      const found = rows(await bounded(signal, () => admin.from('family_inbox_messages').select(INBOX_COLUMNS, { count: 'exact' })
        .eq('family_id', familyId).in('id', [...ids]).limit(ids.size + 1).retry(false).abortSignal(signal)), ids);
      if (found.some(row => row.family_id !== familyId || row.channel !== 'sms' || !['inbound', 'outbound'].includes(String(row.direction)))) return fail();
      return found;
    };
    const displayed = new Map((await readMessages(new Set(sms.map(message => message.id)))).map(row => [row.id as string, row]));
    const receiptForMessage = new Map<string, string>();
    for (const message of sms) {
      const row = displayed.get(message.id);
      if (!row || DISPLAY_FIELDS.some(field => row[field] !== message[field])) continue;
      if (row.direction === 'inbound') {
        if (typeof row.provider_ref === 'string' && SID.test(row.provider_ref)) receiptForMessage.set(message.id, smsReplyReceiptId(familyId, row.provider_ref));
        else result[message.id] = 'legacy_unknown';
      } else if (typeof row.provider_ref === 'string' && row.provider_ref.startsWith(OUTBOUND_PREFIX)) {
        const id = row.provider_ref.slice(OUTBOUND_PREFIX.length);
        if (UUID.test(id) && smsReplyOutboundRef(id) === row.provider_ref && smsReplyOutboundId(id) === row.id) receiptForMessage.set(message.id, id);
      } else result[message.id] = 'legacy_unknown';
    }
    const ids = new Set(receiptForMessage.values());
    if (!ids.size) return result;
    const rawReceipts = rows(await bounded(signal, () => admin.from('ai_tool_calls').select(SMS_REPLY_COLUMNS, { count: 'exact' })
      .eq('family_id', familyId).eq('tool_name', TOOL).in('id', [...ids]).limit(ids.size + 1).retry(false).abortSignal(signal)), ids);
    const receipts = new Map<string, SmsReplyReceipt | null>();
    for (const raw of rawReceipts) {
      try {
        const receipt = validateSmsReplyReceipt(raw);
        receipts.set(raw.id as string, receipt.binding.familyId === familyId ? receipt : null);
      } catch { receipts.set(raw.id as string, null); }
    }
    const relatedIds = new Set<string>();
    for (const receipt of receipts.values()) {
      if (!receipt) continue;
      if (receipt.inboundId && !displayed.has(receipt.inboundId)) relatedIds.add(receipt.inboundId);
      if (receipt.phase === 'emission_reserved' && receipt.outboundId && !displayed.has(receipt.outboundId)) relatedIds.add(receipt.outboundId);
    }
    for (const row of await readMessages(relatedIds)) displayed.set(row.id as string, row);
    for (const [messageId, receiptId] of receiptForMessage) {
      const message = displayed.get(messageId)!;
      if (!receipts.has(receiptId)) {
        result[messageId] = message.direction === 'inbound' ? 'legacy_unknown' : 'unavailable';
        continue;
      }
      const receipt = receipts.get(receiptId);
      if (!receipt || !receipt.inboundId || !inboundMatches(displayed.get(receipt.inboundId), receipt)) continue;
      if (message.direction === 'inbound' ? receipt.inboundId !== messageId : !outboundMatches(message, receipt)) continue;
      if (receipt.phase === 'emission_reserved' && !outboundMatches(displayed.get(receipt.outboundId!), receipt)) continue;
      result[messageId] = receipt.phase === 'queued' ? 'prepared' : receipt.phase === 'emission_reserved'
        ? receipt.delivery ? receipt.delivery.status === 'queued' ? 'provider_queued' : receipt.delivery.status : 'confirmation_unknown'
        : receipt.phase;
    }
    return result;
  } catch {
    // Content already loaded by the page stays visible; no private diagnostics escape.
    return Object.fromEntries(sms.map(message => [message.id, 'unavailable']));
  } finally { clearTimeout(timer); }
}
