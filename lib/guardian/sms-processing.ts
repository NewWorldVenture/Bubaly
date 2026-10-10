import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { runDecisionPipeline } from './pipeline';
import { detectScamWithAI } from './scam-ai';
import { formatPhone } from './phone';
import { shouldRingImmediately } from './trust';
import { claimGuardianSms, finishGuardianSms, releaseGuardianSms, type GuardianSmsLease } from './sms-intake';
import { captureGuardianSmsReceipt, readGuardianSmsReceipt, readGuardianSmsReceiptById, saveGuardianSmsDecision,
  markGuardianSmsCompleted, guardianSmsReceiptId, type GuardianSmsReceipt, type GuardianSmsReceiptInput, type GuardianSmsDecision } from './sms-receipt';
import { guardianSmsScope, notifyGuardianSms } from './sms-notification';
import { smsStep } from './sms-deadline';
import { escalateGuardianEmergency } from './escalate';
import { GUARDIAN_INBOUND_CAP_REASON, GUARDIAN_INBOUND_FAMILY_CAP, GUARDIAN_INBOUND_SENDER_CAP, GUARDIAN_INBOUND_WINDOW_MS } from './inbound-caps';

type Client = SupabaseClient<Database>;
type Options = { signal?: AbortSignal };
export type GuardianSmsProcessingResult = 'completed' | 'busy' | 'unavailable';
type SignedInput = Pick<GuardianSmsReceiptInput, 'smsSid' | 'from' | 'to' | 'body'>;
type Destination = { id: string; family_id: string; member_id: string; guardian_phone: string; is_active: boolean };
const TOTAL_MS = 45_000;
/**
 * The emergency escalation texts AND calls every manager (two Twilio requests
 * per manager, 15 s deadline each) around five database round-trips, so the
 * step's default 5 s budget was a timeout waiting to happen: the alerts kept
 * going out detached while the route answered 503 and Twilio retried into the
 * escalation's own claim. Bounded by the message's total budget either way.
 */
const ESCALATION_MS = 30_000;
const MAX_DECISION_FILTER_CHARS = 4096;
/** How long a filed "add to contacts?" suggestion keeps the same sender from being suggested again. */
const SUGGESTION_MEMORY_MS = 60 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTING_MODES = ['immediate_ring', 'immediate_ai_summary', 'ai_handle_first', 'voicemail_first', 'silent_handling', 'blocked'];
const TRUST_LEVELS = ['immediate_family', 'close_family', 'trusted_friend', 'known_contact', 'unknown', 'suspected_spam', 'blocked'];
const COMM_COLUMNS = 'id,family_id,member_id,comm_type,direction,from_number,to_number,body,from_name,contact_id,trust_level_at_time,routing_mode_used,routing_rule_id,ai_decision_reason,scam_detected,scam_type,scam_confidence,status,twilio_sms_sid';
type SavedSms = {
  id: string; family_id: string; member_id: string; comm_type: string; direction: string; from_number: string | null; to_number: string; body: string;
  from_name: string | null; contact_id: string | null; trust_level_at_time: string | null; routing_mode_used: string | null;
  routing_rule_id: string | null; ai_decision_reason: string | null; scam_detected: boolean; scam_type: string | null;
  scam_confidence: number | null; status: string; twilio_sms_sid: string;
};
const validId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const PENDING_DECISION = {
  status: 'screening', contact_id: null, from_name: null, trust_level_at_time: null, routing_mode_used: null,
  routing_rule_id: null, ai_decision_reason: null, scam_detected: false, scam_type: null, scam_confidence: null,
} as const;
type SmsDecision = Pick<SavedSms, keyof typeof PENDING_DECISION>;
const DECISION_COLUMNS = Object.keys(PENDING_DECISION) as Array<keyof SmsDecision>;
const sameDecision = (row: SavedSms, decision: SmsDecision): boolean => DECISION_COLUMNS.every(key => row[key] === decision[key]);
const pendingDecision = (row: SavedSms): boolean => sameDecision(row, PENDING_DECISION);
const observedDecision = (row: SavedSms): boolean => ['received', 'screening', 'handled', 'escalated', 'blocked', 'missed', 'failed'].includes(row.status)
  && (row.routing_mode_used === null || typeof row.routing_mode_used === 'string' && ROUTING_MODES.includes(row.routing_mode_used))
  && (row.trust_level_at_time === null || typeof row.trust_level_at_time === 'string' && TRUST_LEVELS.includes(row.trust_level_at_time))
  && (row.ai_decision_reason === null || typeof row.ai_decision_reason === 'string') && typeof row.scam_detected === 'boolean'
  && (row.scam_confidence === null || Number.isInteger(row.scam_confidence) && row.scam_confidence >= 0 && row.scam_confidence <= 100)
  && (row.routing_rule_id === null || validId(row.routing_rule_id)) && (row.scam_type === null || typeof row.scam_type === 'string')
  && (row.from_name === null || typeof row.from_name === 'string') && (row.contact_id === null || validId(row.contact_id));
function unavailable(): never { throw new Error('Guardian SMS processing unavailable'); }
// The eight guardian_* tables are declared in database.types.ts, so these reads
// go through the generated types rather than a hand-rolled cast layer. The name
// is constrained to the generated table list, so a typo is a compile error.
type GuardianTable = Extract<keyof Database['public']['Tables'], `guardian_${string}`>;
const table = (client: Client, name: GuardianTable) => client.from(name) as ReturnType<Client['from']>;
function resultEnvelope(raw: unknown): { data: unknown; error: unknown; count: unknown } {
  if (!raw || typeof raw !== 'object' || !('data' in raw) || !('error' in raw) || !('count' in raw)) return unavailable();
  return { data: raw.data, error: raw.error, count: raw.count };
}

async function destination(client: Client, to: string, signal: AbortSignal): Promise<Destination | null> {
  const result = resultEnvelope(await smsStep(signal, current => table(client, 'guardian_member_profiles')
    .select('id,family_id,member_id,guardian_phone,is_active', { count: 'exact' }).eq('guardian_phone', to)
    .eq('is_active', true).limit(2).retry(false).abortSignal(current)));
  if (result.error || !Array.isArray(result.data) || result.count !== result.data.length || result.data.length > 1) return unavailable();
  const row = result.data[0] as unknown as Destination | undefined;
  if (!row) return null;
  if (!validId(row.id) || !validId(row.family_id) || !validId(row.member_id) || row.guardian_phone !== to || row.is_active !== true) return unavailable();
  return row;
}
async function ownsDestination(client: Client, input: GuardianSmsReceiptInput, signal: AbortSignal): Promise<void> {
  const target = await destination(client, input.to, signal);
  if (!target || target.family_id !== input.familyId || target.member_id !== input.memberId) return unavailable();
  const member = await smsStep(signal, current => client.from('family_members').select('id,family_id,is_active', { count: 'exact' })
    .eq('id', input.memberId).eq('family_id', input.familyId).eq('is_active', true).limit(2).retry(false).abortSignal(current));
  if (member.error || !Array.isArray(member.data) || member.count !== 1 || member.data.length !== 1
    || member.data[0].id !== input.memberId || member.data[0].family_id !== input.familyId || member.data[0].is_active !== true) return unavailable();
}
async function ownsLease(client: Client, lease: GuardianSmsLease, signal: AbortSignal): Promise<void> {
  const result = await smsStep(signal, current => client.from('guardian_callback_events')
    .select('event_id,callback_type,status,error,processed_at', { count: 'exact' }).eq('event_id', lease.eventId)
    .limit(2).retry(false).abortSignal(current));
  if (result.error || !Array.isArray(result.data) || result.data.length !== 1 || result.count !== 1) return unavailable();
  const row = result.data[0];
  if (row.event_id !== lease.eventId || row.callback_type !== 'inbound_sms' || row.status !== 'processing'
    || row.error !== `sms-lease:${lease.token}` || row.processed_at !== null) return unavailable();
}
async function readSaved(client: Client, input: GuardianSmsReceiptInput, signal: AbortSignal): Promise<SavedSms | null> {
  const result = resultEnvelope(await smsStep(signal, current => table(client, 'guardian_communications').select(COMM_COLUMNS, { count: 'exact' })
    .eq('twilio_sms_sid', input.smsSid).limit(2).retry(false).abortSignal(current)));
  if (result.error || !Array.isArray(result.data) || result.count !== result.data.length || result.data.length > 1) return unavailable();
  if (!result.data.length) return null;
  const row = result.data[0] as unknown as SavedSms;
  if (!validId(row.id) || row.family_id !== input.familyId || row.member_id !== input.memberId || row.to_number !== input.to
    || row.from_number !== input.from || row.body !== input.body || row.twilio_sms_sid !== input.smsSid
    || row.comm_type !== 'sms_inbound' || row.direction !== 'inbound' || !observedDecision(row)) return unavailable();
  return row;
}
async function retain(client: Client, input: GuardianSmsReceiptInput, id: string, signal: AbortSignal): Promise<SavedSms> {
  try {
    await smsStep(signal, current => table(client, 'guardian_communications').insert({
      id, family_id: input.familyId, member_id: input.memberId, comm_type: 'sms_inbound', direction: 'inbound',
      from_number: input.from, to_number: input.to, body: input.body, twilio_sms_sid: input.smsSid, ...PENDING_DECISION,
    }).select('id').retry(false).abortSignal(current));
  } catch { /* Reconcile lost retention responses through the exact signed SID. */ }
  const row = await readSaved(client, input, signal);
  if (!row || row.id !== id || !pendingDecision(row)) return unavailable();
  return row;
}

type InboundCap = { sender: boolean; family: boolean };
const UNDER_CAP: InboundCap = { sender: false, family: false };

/**
 * Whether this sender, and whether this family, is past its rolling inbound
 * cap. The count includes the message being processed (it was retained
 * first). A count that cannot be read is not a reason to stop analysing
 * messages, so it reads as under the cap.
 */
async function overInboundCap(client: Client, input: GuardianSmsReceiptInput, signal: AbortSignal): Promise<InboundCap> {
  const since = new Date(Date.now() - GUARDIAN_INBOUND_WINDOW_MS).toISOString();
  const count = async (sender: boolean): Promise<number> => {
    try {
      const result = resultEnvelope(await smsStep(signal, current => {
        let query = table(client, 'guardian_communications').select('id', { count: 'exact', head: true })
          .eq('family_id', input.familyId).eq('comm_type', 'sms_inbound').gte('started_at', since);
        if (sender) query = input.from === null ? query.is('from_number', null) : query.eq('from_number', input.from);
        return query.retry(false).abortSignal(current);
      }));
      return !result.error && typeof result.count === 'number' ? result.count : 0;
    } catch { return 0; }
  };
  const [fromSender, forFamily] = await Promise.all([count(true), count(false)]);
  return { sender: fromSender > GUARDIAN_INBOUND_SENDER_CAP, family: forFamily > GUARDIAN_INBOUND_FAMILY_CAP };
}

async function processOwned(client: Client, input: GuardianSmsReceiptInput, lease: GuardianSmsLease,
  trusted: GuardianSmsReceipt | null, allowCapture: boolean, signal: AbortSignal): Promise<GuardianSmsProcessingResult> {
  await ownsDestination(client, input, signal);
  let comm = await readSaved(client, input, signal);
  let receipt = trusted;
  if (!receipt) {
    if (!allowCapture) return unavailable();
    try { receipt = await readGuardianSmsReceipt(client, input, { signal }); }
    catch {
      if (!comm) { await ownsLease(client, lease, signal); await retain(client, input, randomUUID(), signal); }
      return unavailable();
    }
  }
  if (receipt?.phase === 'completed') {
    if (!comm || comm.id !== receipt.communicationId || !receipt.decision || !sameDecision(comm, receipt.decision)) return unavailable();
    await ownsDestination(client, input, signal);
    await ownsLease(client, lease, signal);
    if (!await finishGuardianSms(client, lease, signal)) return 'unavailable';
    await ownsDestination(client, input, signal);
    await markGuardianSmsCompleted(client, receipt, { signal });
    return 'completed';
  }
  if (!comm) {
    await ownsLease(client, lease, signal);
    comm = await retain(client, input, receipt?.communicationId ?? randomUUID(), signal);
  }
  if (!receipt) {
    await ownsLease(client, lease, signal);
    receipt = await captureGuardianSmsReceipt(client, input, comm.id, { signal });
  }
  if (receipt.communicationId !== comm.id) return unavailable();
  const fence = async () => {
    signal.throwIfAborted();
    await ownsDestination(client, input, signal);
    await ownsLease(client, lease, signal);
  };
  if (!receipt.decision) {
    await fence();
    const decision = await smsStep(signal, () => runDecisionPipeline(client, {
      callerPhone: input.from, callerName: null, familyId: input.familyId, memberId: input.memberId, initialTranscript: input.body,
    }));
    await fence();
    // No model call where the answer cannot change anything: the family has
    // already blocked this sender, or the pattern detector is already sure.
    // And none past the rolling cap, which is what kept a blocked or spamming
    // sender from buying one LLM request per text.
    const settled = decision.routingMode === 'blocked' || (decision.scamDetected === true && decision.spamScore >= 80);
    const cap = settled ? UNDER_CAP : await overInboundCap(client, input, signal);
    // Past either cap the pattern detector decides alone, whoever is texting:
    // that is the bound on model spend. But only a sender the family has not
    // vouched for is HELD. A contact at a ring-through trust level (immediate
    // family, close family, trusted friend) is who the Guardian number exists
    // to let through, and their eleventh text in an hour is still a text from
    // them. The family-wide flood cap holds for everyone.
    const modelCapped = cap.sender || cap.family;
    const throttled = cap.family || (cap.sender && !shouldRingImmediately(decision.trustLevel));
    const scam = settled || modelCapped
      ? { isScam: decision.scamDetected === true, scamType: decision.scamType ?? null,
        confidence: decision.scamDetected === true && Number.isFinite(decision.spamScore) ? Math.min(100, Math.max(0, decision.spamScore)) : 0 }
      : await smsStep(signal, current => detectScamWithAI(input.body, input.from, `Family ID: ${input.familyId}`, current), 15_000);
    if (!ROUTING_MODES.includes(decision.routingMode) || !TRUST_LEVELS.includes(decision.trustLevel)
      || (decision.contactId !== null && !validId(decision.contactId)) || (decision.ruleId !== null && !validId(decision.ruleId))
      || (decision.contactName !== null && typeof decision.contactName !== 'string') || typeof decision.reason !== 'string'
      || typeof scam.isScam !== 'boolean' || typeof scam.confidence !== 'number' || !Number.isFinite(scam.confidence)
      || scam.confidence < 0 || scam.confidence > 100 || (scam.scamType !== null && typeof scam.scamType !== 'string')) return unavailable();
    const confidence = Math.floor(scam.confidence);
    const fields: GuardianSmsDecision = {
      contact_id: decision.contactId, from_name: decision.contactName, trust_level_at_time: decision.trustLevel,
      routing_mode_used: decision.routingMode, routing_rule_id: decision.ruleId,
      // A routine message past the cap is held as `blocked`, and the record
      // says why: that is what keeps the family unpinged on a flood, and the
      // one durable answer a retried delivery (which cannot recount the window)
      // completes against.
      ai_decision_reason: throttled ? `${decision.reason} ${GUARDIAN_INBOUND_CAP_REASON}` : decision.reason,
      scam_detected: scam.isScam, scam_type: scam.scamType, scam_confidence: confidence,
      // An emergency from a sender the family has not blocked is never
      // discarded on a scam score: a real "help me" can read like a scam.
      status: decision.shouldEscalate === true ? 'escalated' : (scam.isScam && confidence >= 80) || throttled ? 'blocked' : 'received',
    };
    await fence();
    receipt = await saveGuardianSmsDecision(client, receipt, fields, { signal });
  }
  const fields = receipt.decision;
  if (!fields) return unavailable();
  if (!sameDecision(comm, fields)) {
    const observed = comm;
    const size = DECISION_COLUMNS.reduce((total, key) => total + (typeof observed[key] === 'string' ? encodeURIComponent(observed[key] as string).length : 0), 0);
    if (size > MAX_DECISION_FILTER_CHARS) return unavailable();
    await fence();
    try {
      await smsStep(signal, current => {
        let update = table(client, 'guardian_communications').update(fields)
          .eq('id', observed.id).eq('family_id', input.familyId).eq('member_id', input.memberId).eq('twilio_sms_sid', input.smsSid)
          .eq('comm_type', 'sms_inbound').eq('direction', 'inbound').eq('to_number', input.to);
        for (const key of DECISION_COLUMNS) update = observed[key] === null ? update.is(key, null) : update.eq(key, observed[key]);
        update = input.from === null ? update.is('from_number', null) : update.eq('from_number', input.from);
        return update.select('id').retry(false).abortSignal(current);
      });
    } catch { /* Exact readback reconciles a lost decision response. */ }
  }
  const exactDecision = async () => {
    const saved = await readSaved(client, input, signal);
    if (!saved || saved.id !== receipt.communicationId || !sameDecision(saved, fields)) return unavailable();
    return saved;
  };
  comm = await exactDecision();
  if (comm.contact_id) {
    try {
      await fence();
      await smsStep(signal, current => table(client, 'guardian_contacts').update({ last_contact_at: new Date().toISOString() })
        .eq('family_id', input.familyId).eq('id', comm!.contact_id!).retry(false).abortSignal(current));
    } catch { /* Optional contact recency cannot establish message completion. */ }
  }
  const emergency = fields.status === 'escalated';
  const blocked = !emergency && (fields.status === 'blocked' || fields.routing_mode_used === 'blocked' || fields.scam_detected && fields.scam_confidence >= 80);
  if (!blocked) {
    const scope = await smsStep(signal, current => guardianSmsScope(client, input.familyId, current));
    if (!scope || scope.familyId !== input.familyId) return unavailable();
    await fence();
    const sender = fields.from_name ?? formatPhone(input.from);
    const notified = await smsStep(signal, current => notifyGuardianSms(scope, {
      recipients: 'family', type: 'system', title: emergency ? `🚨 Emergency text from ${sender}` : `💬 Text from ${sender}`,
      body: input.body.length > 100 ? `${input.body.slice(0, 100)}…` : input.body,
      relatedType: 'guardian_communications', relatedId: receipt.communicationId, once: true,
      // Quiet hours hold a routine text until morning; they must not hold this.
      ...(emergency ? { urgent: true } : {}),
    }, { receiptId: receipt.id, signal: current, beforeWrite: async () => { await fence(); await exactDecision(); } }), 15_000);
    if (!notified.ok || !Number.isInteger(notified.data.created) || !Number.isInteger(notified.data.duplicates)
      || notified.data.created < 0 || notified.data.duplicates < 0 || notified.data.created + notified.data.duplicates !== 1
      || !Array.isArray(notified.data.ids) || notified.data.ids.length !== notified.data.created || !notified.data.ids.every(validId)) return unavailable();
    // Preserve the existing optional suggestion for repeated unknown callers.
    if (fields.trust_level_at_time === 'unknown' && input.from) {
      try {
        const count = resultEnvelope(await smsStep(signal, current => table(client, 'guardian_communications').select('*', { count: 'exact', head: true })
          .eq('family_id', input.familyId).eq('from_number', input.from!).retry(false).abortSignal(current)));
        if (!count.error && typeof count.count === 'number' && count.count >= 3) {
          const messageCount = count.count;
          // Keyed on THIS sender: any one update_trust row used to stop every
          // other repeat sender from ever being suggested (and two of them made
          // maybeSingle fail). A dismissed suggestion for this sender is
          // remembered for the same window the learning run looks back over.
          const remembered = new Date(Date.now() - SUGGESTION_MEMORY_MS).toISOString();
          const existing = resultEnvelope(await smsStep(signal, current => table(client, 'guardian_suggestions').select('id')
            .eq('family_id', input.familyId).eq('suggestion_type', 'update_trust').eq('evidence->>phone', input.from!)
            .or(`status.eq.pending,created_at.gte.${remembered}`).limit(1).retry(false).abortSignal(current)));
          if (!existing.error && Array.isArray(existing.data) && existing.data.length === 0) {
            await fence();
            await exactDecision();
            await smsStep(signal, current => table(client, 'guardian_suggestions').insert({
              family_id: input.familyId, suggestion_type: 'update_trust', title: `Add ${formatPhone(input.from)} to your contacts?`,
              reasoning: `${formatPhone(input.from)} has contacted you ${messageCount + 1} times but isn't in your trust graph. Adding them would let you customize how Bubaly handles their messages.`,
              evidence: { phone: input.from, message_count: messageCount }, proposed_trust_level: 'known_contact',
            }).retry(false).abortSignal(current));
          }
        }
      } catch { /* Optional suggestions never establish receipt or completion. */ }
    }
  }
  if (emergency) {
    // Text and call the managers. Keyed on the communication, so a retried
    // delivery is answered by the escalation's own claim instead of alarming
    // twice. A storage failure before anything was sent asks Twilio to retry;
    // an escalation that reached nobody is recorded (and logged) there.
    await fence();
    const escalation = await smsStep(signal, () => escalateGuardianEmergency(client, {
      familyId: input.familyId, commId: receipt.communicationId, escalationType: 'urgent_personal', severity: 'critical',
      description: `Emergency text from ${fields.from_name ?? formatPhone(input.from)}: "${input.body.slice(0, 300)}"`,
      ...(input.from ? { callerNumber: input.from.slice(0, 64) } : {}),
    }), ESCALATION_MS);
    if (escalation.kind === 'claim_unavailable' || escalation.kind === 'read_failed') return unavailable();
    if (escalation.kind !== 'delivered' && escalation.kind !== 'duplicate') {
      console.error('[guardian-sms] emergency escalation did not reach a manager', { familyId: input.familyId, communicationId: receipt.communicationId, outcome: escalation.kind });
    }
  }
  await fence();
  await exactDecision();
  if (!await finishGuardianSms(client, lease, signal)) return 'unavailable';
  await ownsDestination(client, input, signal);
  await markGuardianSmsCompleted(client, receipt, { signal });
  return 'completed';
}

/** Called only by the route after its real signature and payload checks. */
export async function receiveGuardianSms(client: Client, signed: SignedInput, options: Options = {}): Promise<GuardianSmsProcessingResult | 'invalid'> {
  return smsStep(options.signal, async signal => {
    let lease: GuardianSmsLease | undefined;
    try {
      const claim = await claimGuardianSms(client, signed.smsSid, signal);
      if (claim.kind === 'busy' || claim.kind === 'invalid' || claim.kind === 'unavailable') return claim.kind;
      if (claim.kind === 'claimed') lease = claim.lease;
      const target = await destination(client, signed.to, signal);
      if (!target) {
        // An unavailable former destination must not poison an authenticated
        // pending receipt by declaring its callback processed without effects.
        if (await readGuardianSmsReceiptById(client, guardianSmsReceiptId(signed.smsSid), { signal })) return unavailable();
        if (lease && !await finishGuardianSms(client, lease, signal)) return 'unavailable';
        return 'completed';
      }
      const input = { ...signed, familyId: target.family_id, memberId: target.member_id };
      if (!lease) {
        await ownsDestination(client, input, signal);
        const receipt = await readGuardianSmsReceipt(client, input, { signal });
        if (!receipt) return 'unavailable';
        await markGuardianSmsCompleted(client, receipt, { signal });
        return 'completed';
      }
      return await processOwned(client, input, lease, null, true, signal);
    } catch {
      if (lease && !signal.aborted) await releaseGuardianSms(client, lease, signal);
      return 'unavailable';
    }
  }, TOTAL_MS).catch(() => 'unavailable');
}

/** Recovery starts exclusively from service-authored input, never raw messages. */
export async function resumeGuardianSms(client: Client, receiptId: string, options: Options = {}): Promise<GuardianSmsProcessingResult> {
  return smsStep(options.signal, async signal => {
    let lease: GuardianSmsLease | undefined;
    try {
      const receipt = await readGuardianSmsReceiptById(client, receiptId, { signal });
      if (!receipt) return 'unavailable';
      await ownsDestination(client, receipt.input, signal);
      const claim = await claimGuardianSms(client, receipt.input.smsSid, signal);
      if (claim.kind === 'busy') return 'busy';
      if (claim.kind === 'invalid' || claim.kind === 'unavailable') return 'unavailable';
      if (claim.kind === 'processed') {
        await markGuardianSmsCompleted(client, receipt, { signal });
        return 'completed';
      }
      if (claim.kind !== 'claimed') return 'unavailable';
      lease = claim.lease;
      return await processOwned(client, receipt.input, lease, receipt, false, signal);
    } catch {
      if (lease && !signal.aborted) await releaseGuardianSms(client, lease, signal);
      return 'unavailable';
    }
  }, TOTAL_MS).catch(() => 'unavailable');
}
