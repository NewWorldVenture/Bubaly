// app/api/guardian/inbound/sms/route.ts
// Twilio webhook — handles inbound SMS to a Bubaly Guardian number.
// Runs scam detection, logs the message, and notifies the family.

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { notify } from '@/lib/services/notifications';
import { systemScopeForFamily } from '@/lib/services/scope';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { runDecisionPipeline } from '@/lib/guardian/pipeline';
import { detectScamWithAI } from '@/lib/guardian/scam-ai';
import { validateTwilioSignature } from '@/lib/guardian/twilio';
import { formatPhone } from '@/lib/guardian/phone';
import { claimGuardianSms, finishGuardianSms, releaseGuardianSms } from '@/lib/guardian/sms-intake';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim().replace(/\/+$/, '');
const MAX_TWILIO_BODY_BYTES = 64 * 1024;
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
const decided = (row: SavedSms): boolean => row.status !== 'screening'
  && ['received', 'handled', 'escalated', 'blocked', 'missed', 'failed'].includes(row.status)
  && typeof row.routing_mode_used === 'string' && ROUTING_MODES.includes(row.routing_mode_used)
  && typeof row.trust_level_at_time === 'string' && TRUST_LEVELS.includes(row.trust_level_at_time)
  && typeof row.ai_decision_reason === 'string'
  && typeof row.scam_detected === 'boolean' && Number.isInteger(row.scam_confidence)
  && row.scam_confidence !== null && row.scam_confidence >= 0 && row.scam_confidence <= 100
  && (row.routing_rule_id === null || validId(row.routing_rule_id))
  && (row.scam_type === null || typeof row.scam_type === 'string')
  && (row.from_name === null || typeof row.from_name === 'string') && (row.contact_id === null || validId(row.contact_id));

export async function POST(req: NextRequest) {
  const boundedForm = await readBoundedRequestFormData(req, MAX_TWILIO_BODY_BYTES);
  if (!boundedForm.ok) return new NextResponse(boundedForm.reason === 'too_large' ? 'Payload too large' : 'Invalid callback', { status: boundedForm.reason === 'too_large' ? 413 : 400 });
  const seen = new Set<string>();
  for (const [key, value] of boundedForm.value.entries()) {
    if (typeof value !== 'string' || seen.has(key)) return new NextResponse('Invalid callback', { status: 400 });
    seen.add(key);
  }
  const params = Object.fromEntries(boundedForm.value.entries()) as Record<string, string>;

  if (process.env.NODE_ENV === 'production') {
    const sig = req.headers.get('x-twilio-signature') ?? '';
    const url = `${BASE_URL}/api/guardian/inbound/sms`;
    if (!validateTwilioSignature(sig, url, params)) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const from = params.From ?? null;
  const to = params.To ?? null;
  const body = params.Body ?? '';
  const smsSid = params.SmsSid ?? params.MessageSid ?? null;

  if (!smsSid || !/^(SM|MM)[0-9a-f]{32}$/i.test(smsSid) || (params.SmsSid && params.MessageSid && params.SmsSid !== params.MessageSid)
    || !to || !/^\+[1-9]\d{7,14}$/.test(to) || (from !== null && (!from || from.length > 64 || /[\x00-\x1f\x7f]/.test(from))) || body.length > 4096) {
    return new NextResponse('Invalid callback', { status: 400 });
  }

  let supabase: ReturnType<typeof createServiceClient>;
  try { supabase = createServiceClient(); } catch { return new NextResponse('Intake unavailable', { status: 503 }); }
  const claim = await claimGuardianSms(supabase, smsSid);
  if (claim.kind === 'processed') return new NextResponse('', { status: 200 });
  if (claim.kind !== 'claimed') return new NextResponse('Intake unavailable', { status: claim.kind === 'invalid' ? 400 : 503 });
  const db = withGuardianTables(supabase);
  const gFrom = (t: Parameters<typeof db.from>[0]) => (db.from(t) as ReturnType<typeof supabase.from>);
  const deadline = () => AbortSignal.timeout(5000);
  const fail = async () => {
    await releaseGuardianSms(supabase, claim.lease);
    return new NextResponse('Intake unavailable', { status: 503 });
  };
  const finish = async () => (await finishGuardianSms(supabase, claim.lease))
    ? new NextResponse('', { status: 200 }) : new NextResponse('Intake unavailable', { status: 503 });
  // A read fence catches a replaced lease after slow policy/AI work. The later
  // write is still a separate operation; this does not provide a transaction.
  const stillOwnsLease = async (): Promise<boolean> => {
    const current = await supabase.from('guardian_callback_events')
      .select('event_id,callback_type,status,error,processed_at', { count: 'exact' })
      .eq('event_id', smsSid).limit(2).abortSignal(deadline()).retry(false);
    if (current.error || !Array.isArray(current.data) || current.data.length !== 1 || current.count !== 1) return false;
    const row = current.data[0];
    return row?.event_id === smsSid && row.callback_type === 'inbound_sms' && row.status === 'processing'
      && row.error === `sms-lease:${claim.lease.token}` && row.processed_at === null;
  };

  try {
    // Find which family member this number belongs to
    const profiles = await gFrom('guardian_member_profiles')
      .select('id,family_id,member_id,guardian_phone,is_active', { count: 'exact' })
      .eq('guardian_phone', to)
      .eq('is_active', true)
      .limit(2).abortSignal(deadline()).retry(false);
    if (profiles.error || !Array.isArray(profiles.data) || profiles.count !== profiles.data.length || profiles.data.length > 1) return fail();
    const memberProfile = profiles.data[0] as unknown as { id: string; family_id: string; member_id: string; guardian_phone: string; is_active: boolean } | undefined;

    if (!memberProfile) {
      return finish();
    }
    if (!validId(memberProfile.id) || !validId(memberProfile.family_id) || !validId(memberProfile.member_id)
      || memberProfile.guardian_phone !== to || memberProfile.is_active !== true) return fail();

    const familyId = memberProfile.family_id;
    const memberId = memberProfile.member_id;
    const readSaved = async (): Promise<SavedSms | null> => {
      const result = await gFrom('guardian_communications').select(COMM_COLUMNS, { count: 'exact' })
        .eq('twilio_sms_sid', smsSid).limit(2).abortSignal(deadline()).retry(false);
      if (result.error || !Array.isArray(result.data) || result.count !== result.data.length || result.data.length > 1) throw new Error('Communication read unavailable');
      if (result.data.length === 0) return null;
      const row = result.data[0] as unknown as SavedSms;
      if (!validId(row.id) || row.family_id !== familyId || row.member_id !== memberId || row.to_number !== to || row.from_number !== from
        || row.body !== body || row.twilio_sms_sid !== smsSid || row.comm_type !== 'sms_inbound' || row.direction !== 'inbound'
        || (!pendingDecision(row) && !decided(row))) throw new Error('Communication identity unavailable');
      return row;
    };
    let comm = await readSaved();

    if (!comm) {
      // Retain the exact inbound message before any required policy or AI work.
      // The existing nullable decision fields distinguish intake from a decision.
      const intakeId = randomUUID();
      try {
        await gFrom('guardian_communications').insert({
          id: intakeId, family_id: familyId, member_id: memberId, comm_type: 'sms_inbound', direction: 'inbound',
          from_number: from, to_number: to, body, twilio_sms_sid: smsSid, ...PENDING_DECISION,
        }).select('id').abortSignal(deadline()).retry(false);
      } catch { /* Reconcile a lost insert response through the unique provider SID. */ }
      comm = await readSaved();
      if (!comm || comm.id !== intakeId || !pendingDecision(comm)) return fail();
    }

    if (pendingDecision(comm)) {
      // Run decision pipeline
      const decision = await runDecisionPipeline(supabase, {
        callerPhone: from,
        callerName: null,
        familyId,
        memberId,
        initialTranscript: body,
      });

      // Deep scam analysis on SMS body
      const scamResult = await detectScamWithAI(body, from, `Family ID: ${familyId}`);
      if (!ROUTING_MODES.includes(decision.routingMode) || !TRUST_LEVELS.includes(decision.trustLevel)
        || (decision.contactId !== null && !validId(decision.contactId)) || (decision.ruleId !== null && !validId(decision.ruleId))
        || (decision.contactName !== null && typeof decision.contactName !== 'string') || typeof decision.reason !== 'string'
        || typeof scamResult.isScam !== 'boolean' || typeof scamResult.confidence !== 'number' || !Number.isFinite(scamResult.confidence)
        || scamResult.confidence < 0 || scamResult.confidence > 100 || (scamResult.scamType !== null && typeof scamResult.scamType !== 'string')) return fail();
      // The classifier accepts fractional confidence, while the stored column is
      // an integer. Flooring preserves the existing >=80 blocking boundary.
      const confidence = Math.floor(scamResult.confidence);

      const decisionFields: SmsDecision = {
        contact_id: decision.contactId, from_name: decision.contactName, trust_level_at_time: decision.trustLevel,
        routing_mode_used: decision.routingMode, routing_rule_id: decision.ruleId, ai_decision_reason: decision.reason,
        scam_detected: scamResult.isScam, scam_type: scamResult.scamType, scam_confidence: confidence,
        status: scamResult.isScam && confidence >= 80 ? 'blocked' : 'received',
      };
      const intakeId = comm.id;
      if (!await stillOwnsLease()) return fail();
      try {
        let update = gFrom('guardian_communications').update(decisionFields)
          .eq('id', intakeId).eq('family_id', familyId).eq('member_id', memberId).eq('twilio_sms_sid', smsSid)
          .eq('comm_type', 'sms_inbound').eq('direction', 'inbound').eq('to_number', to)
          .eq('status', 'screening').eq('scam_detected', false)
          .is('contact_id', null).is('from_name', null).is('trust_level_at_time', null).is('routing_mode_used', null)
          .is('routing_rule_id', null).is('ai_decision_reason', null).is('scam_type', null).is('scam_confidence', null);
        update = from === null ? update.is('from_number', null) : update.eq('from_number', from);
        await update.select('id').abortSignal(deadline()).retry(false);
      } catch { /* Reconcile a lost decision response without overwriting another decision. */ }
      // SMS bodies are retained unchanged by this path. Verify the exact body
      // again without placing private, potentially long text in the PATCH URL.
      comm = await readSaved();
      if (!comm || comm.id !== intakeId || !decided(comm) || !sameDecision(comm, decisionFields)) return fail();
    }

    // Update contact last contact timestamp
    if (comm.contact_id) {
      try {
        await gFrom('guardian_contacts')
          .update({ last_contact_at: new Date().toISOString() })
          .eq('family_id', familyId).eq('id', comm.contact_id).abortSignal(deadline()).retry(false);
      } catch { /* Optional contact recency does not replace message receipt. */ }
    }

    // For blocked/spam — silently discard (don't auto-reply)
    if (comm.status === 'blocked' || comm.routing_mode_used === 'blocked' || (comm.scam_detected && comm.scam_confidence !== null && comm.scam_confidence >= 80)) {
      return finish();
    }

    // Notify the family member
    const callerDisplay = comm.from_name ?? formatPhone(from);
    const preview = body.length > 100 ? `${body.slice(0, 100)}…` : body;

    // Through notify() rather than a raw insert, so a routine screened text
    // obeys the family's quiet hours. This row fires for EVERY message that is
    // not blocked or spam — it is the most frequent notification the product
    // writes, and a raw insert made it the one most likely to wake a house at
    // two in the morning. Not `urgent`: a text from the dentist can wait until
    // the window ends. A genuine emergency comes through /api/guardian/escalate,
    // which is marked urgent and still lands immediately.
    const scope = await systemScopeForFamily(supabase, familyId);
    if (!scope) return fail();
    if (!await stillOwnsLease()) return fail();
    const notified = await notify(scope, {
      recipients: 'family',
      type: 'system',
      title: `💬 Text from ${callerDisplay}`,
      body: preview,
      relatedType: 'guardian_communications',
      relatedId: comm.id,
      once: true,
    });
    if (!notified.ok || !Number.isInteger(notified.data.created) || !Number.isInteger(notified.data.duplicates)
      || notified.data.created < 0 || notified.data.duplicates < 0 || notified.data.created + notified.data.duplicates !== 1
      || !Array.isArray(notified.data.ids) || notified.data.ids.length !== notified.data.created || !notified.data.ids.every(validId)) return fail();

    // Suggest trust upgrade if this is a repeated unknown contact
    if (comm.trust_level_at_time === 'unknown' && from) {
      try {
        const { count, error: countError } = await gFrom('guardian_communications')
          .select('*', { count: 'exact', head: true })
          .eq('family_id', familyId)
          .eq('from_number', from).abortSignal(deadline()).retry(false);

        if (!countError && (count ?? 0) >= 3) {
          const existing = await gFrom('guardian_suggestions')
            .select('id')
            .eq('family_id', familyId)
            .eq('suggestion_type', 'update_trust')
            .maybeSingle().abortSignal(deadline()).retry(false);

          if (!existing.error && !existing.data) {
            await gFrom('guardian_suggestions').insert({
              family_id: familyId,
              suggestion_type: 'update_trust',
              title: `Add ${formatPhone(from)} to your contacts?`,
              reasoning: `${formatPhone(from)} has contacted you ${(count ?? 0) + 1} times but isn't in your trust graph. Adding them would let you customize how Bubaly handles their messages.`,
              evidence: { phone: from, message_count: (count ?? 0) + 1 },
              proposed_trust_level: 'known_contact',
            }).abortSignal(deadline()).retry(false);
          }
        }
      } catch { /* Suggestions are optional and never establish receipt of the SMS. */ }
    }

    return finish();
  } catch { return fail(); }
}
