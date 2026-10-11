// app/api/guardian/inbound/whatsapp/route.ts
// Twilio webhook — handles inbound WhatsApp messages to a Bubaly Guardian number.
// Twilio delivers WhatsApp on the same Messages webhook with a `whatsapp:` prefix
// on From/To. Runs scam detection, logs the message, and notifies the family.

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { notify } from '@/lib/services/notifications';
import { systemScopeForFamily } from '@/lib/services/scope';
import { runDecisionPipeline } from '@/lib/guardian/pipeline';
import { detectScamWithAI } from '@/lib/guardian/scam-ai';
import { twilioRefusal, verifyTwilioRequest } from '@/lib/server/twilio-ingress';
import { formatPhone } from '@/lib/guardian/phone';
import { shouldRingImmediately } from '@/lib/guardian/trust';
import { claimGuardianCallback, isValidGuardianEventId, markGuardianCallbackProcessed, releaseGuardianCallback } from '@/lib/guardian/callbacks';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { escalateGuardianEmergency } from '@/lib/guardian/escalate';
import { GUARDIAN_INBOUND_CAP_REASON, GUARDIAN_INBOUND_FAMILY_CAP, GUARDIAN_INBOUND_SENDER_CAP, GUARDIAN_INBOUND_WINDOW_MS } from '@/lib/guardian/inbound-caps';

export const runtime = 'nodejs';

const MAX_TWILIO_BODY_BYTES = 64 * 1024;

type InboundCap = { sender: boolean; family: boolean };
const UNDER_CAP: InboundCap = { sender: false, family: false };

/**
 * Whether this sender, and whether this family, is past the rolling inbound
 * cap (the same caps as the SMS lane). A count that cannot be read reads as
 * under it.
 */
async function overInboundCap(supabase: ReturnType<typeof createServiceClient>, familyId: string, from: string | null): Promise<InboundCap> {
  const since = new Date(Date.now() - GUARDIAN_INBOUND_WINDOW_MS).toISOString();
  const count = async (sender: boolean): Promise<number> => {
    try {
      let query = supabase.from('guardian_communications').select('id', { count: 'exact', head: true })
        .eq('family_id', familyId).eq('comm_type', 'whatsapp_inbound').gte('started_at', since);
      if (sender) query = from === null ? query.is('from_number', null) : query.eq('from_number', from);
      const { count: n, error } = await query;
      return !error && typeof n === 'number' ? n : 0;
    } catch { return 0; }
  };
  const [fromSender, forFamily] = await Promise.all([count(true), count(false)]);
  // The current message is not recorded yet, so it is the one past `>=`.
  return { sender: fromSender >= GUARDIAN_INBOUND_SENDER_CAP, family: forFamily >= GUARDIAN_INBOUND_FAMILY_CAP };
}

/** Strip Twilio's `whatsapp:` channel prefix, leaving a bare E.164 number. */
function stripChannel(addr: string | null): string | null {
  if (!addr) return null;
  return addr.replace(/^whatsapp:/i, '');
}

export async function POST(req: NextRequest) {
  const boundedForm = await readBoundedRequestFormData(req, MAX_TWILIO_BODY_BYTES);
  if (!boundedForm.ok) return new NextResponse(boundedForm.reason === 'too_large' ? 'Payload too large' : 'Invalid callback', { status: boundedForm.reason === 'too_large' ? 413 : 400 });
  const params = Object.fromEntries(boundedForm.value.entries()) as Record<string, string>;

  const verdict = verifyTwilioRequest(req, params, 'guardian/inbound/whatsapp');
  if (!verdict.ok) return twilioRefusal(verdict);

  const from = stripChannel(params.From ?? null);
  const to = stripChannel(params.To ?? null);
  const body = params.Body ?? '';
  const smsSid = params.SmsSid ?? params.MessageSid ?? null;

  // `To` is the Guardian number the message reached, and it is the ONLY thing
  // that resolves which family this belongs to. Without it the profile lookup
  // matches nothing and the callback is consumed anyway — so refuse it here,
  // before the claim, rather than after.
  if (!isValidGuardianEventId(smsSid) || !to || body.length > 4096) {
    return new NextResponse('Invalid callback', { status: 400 });
  }

  const supabase = createServiceClient();
  const claim = await claimGuardianCallback(supabase, 'inbound_whatsapp', smsSid);
  // The claim could not be written, so nothing here has been recorded. A 200
  // would tell Twilio this callback succeeded and it would never retry; a 503
  // asks it to come back. Silence is the one answer that loses the event.
  if (claim === 'unavailable') return new NextResponse('', { status: 503 });
  if (claim !== 'claimed') return new NextResponse('', { status: 200 });

  // Find which family member this Guardian number belongs to.
  const { data: memberProfile, error: profileError } = await supabase.from('guardian_member_profiles')
    .select('id, family_id, member_id, default_mode_suspected_spam, default_mode_blocked, default_mode_unknown')
    .eq('guardian_phone', to)
    .eq('is_active', true)
    .maybeSingle();

  // A FAILED lookup is not an unknown number. `maybeSingle()` answers
  // `data: null` plus PGRST116 when MORE THAN ONE profile holds this number —
  // which is exactly the state 0310's unique index exists to prevent, and which
  // a production database may already be in, because 0310 reports duplicates
  // rather than choosing which household loses its number. Dropping the error
  // turned that into "we do not know this number", and marked the message handled and answered 200, so nothing was ever retried. Answering 5xx
  // instead leaves the event unconsumed so Twilio retries it, and puts the
  // reason somewhere a person can find.
  if (profileError) {
    console.error('[guardian-whatsapp] Guardian number lookup failed', { to, error: profileError });
    // The claim has to go back too. Held, it made the retry this 503 asks for
    // a 'settled' duplicate for ten minutes — acknowledged, and lost.
    await releaseGuardianCallback(supabase, 'inbound_whatsapp', smsSid);
    return new NextResponse('', { status: 503 });
  }

  if (!memberProfile) {
    await markGuardianCallbackProcessed(supabase, smsSid);
    return new NextResponse('', { status: 200 });
  }

  const familyId = (memberProfile as { family_id: string }).family_id;
  const memberId = (memberProfile as { member_id: string }).member_id;

  // Run decision pipeline.
  let decision: Awaited<ReturnType<typeof runDecisionPipeline>>;
  try {
    decision = await runDecisionPipeline(supabase, {
      callerPhone: from,
      callerName: null,
      familyId,
      memberId,
      initialTranscript: body,
    });
  } catch {
    // Nothing has been written yet (the pipeline only reads), so the retry may
    // take the event from the start.
    await releaseGuardianCallback(supabase, 'inbound_whatsapp', smsSid);
    return new NextResponse('Guardian routing unavailable', { status: 503 });
  }

  // Deep scam analysis on the message body — but no model call where the
  // answer cannot change anything (the sender is already blocked, or the
  // pattern detector is already sure), and none past the rolling per-sender /
  // per-family cap, so a spamming sender cannot buy one LLM request per text.
  // Past the per-sender cap only a sender the family has not vouched for is
  // HELD: a contact at a ring-through trust level (immediate family, close
  // family, trusted friend) is still delivered, as in the SMS lane. The
  // family-wide flood cap holds for everyone.
  const settled = decision.routingMode === 'blocked' || (decision.scamDetected && decision.spamScore >= 80);
  const cap = settled ? UNDER_CAP : await overInboundCap(supabase, familyId, from);
  const modelCapped = cap.sender || cap.family;
  const throttled = cap.family || (cap.sender && !shouldRingImmediately(decision.trustLevel));
  const scamResult = settled || modelCapped
    ? { isScam: decision.scamDetected, scamType: decision.scamType, confidence: decision.scamDetected ? Math.min(100, Math.max(0, decision.spamScore)) : 0 }
    : await detectScamWithAI(body, from, `Family ID: ${familyId}`);
  const emergency = decision.shouldEscalate;

  // Create communication record.
  //
  // The voice twin of this (`inbound/voice/route.ts`) has the same defect and
  // the same reasoning: a dropped error means the message is delivered but
  // never recorded, so the family's guardian history — including the scam
  // verdict just computed above — silently loses the entry. Here it also
  // reaches the notification below as `relatedId: comm?.id ?? null`, so the
  // family gets an alert that links back to nothing.
  //
  // Not fatal to the message, which must still be delivered, so it degrades
  // loudly rather than failing. Audit C1-S9-39.
  const { data: comm, error: commError } = await supabase.from('guardian_communications').insert({
    family_id: familyId,
    member_id: memberId,
    contact_id: decision.contactId,
    comm_type: 'whatsapp_inbound',
    direction: 'inbound',
    from_number: from,
    to_number: to,
    from_name: decision.contactName,
    body,
    trust_level_at_time: decision.trustLevel,
    routing_mode_used: decision.routingMode,
    routing_rule_id: decision.ruleId,
    // A routine message past the cap is recorded as `blocked`, and the reason
    // says why: kept in the inbox, no family alert.
    ai_decision_reason: throttled ? `${decision.reason} ${GUARDIAN_INBOUND_CAP_REASON}` : decision.reason,
    scam_detected: scamResult.isScam,
    scam_type: scamResult.scamType,
    scam_confidence: scamResult.confidence,
    twilio_sms_sid: smsSid,
    status: emergency ? 'escalated' : (scamResult.isScam && scamResult.confidence >= 80) || throttled ? 'blocked' : 'received',
  }).select('id').maybeSingle();

  if (commError) {
    console.error('[guardian/inbound/whatsapp] could not record the communication; message continues unlogged', {
      familyId, smsSid, error: commError.message,
    });
  }

  // Update contact last-contact timestamp.
  if (decision.contactId) {
    const { error: touchError } = await supabase.from('guardian_contacts')
      .update({ last_contact_at: new Date().toISOString() })
      .eq('id', decision.contactId);
    // Cosmetic on its own, but "last heard from" is one of the signals a parent
    // uses to judge a contact, so a stale one is a quiet wrong answer.
    if (touchError) {
      console.error('[guardian/inbound/whatsapp] could not touch the contact', {
        contactId: decision.contactId, error: touchError.message,
      });
    }
  }

  // Blocked / high-confidence spam — silently discard. Never an emergency from
  // a sender the family has not blocked (the pipeline does not set
  // shouldEscalate for a blocked one): a real "help me" can score like a scam.
  // Past the rolling cap the message is kept in the inbox without a ping.
  if (!emergency && (decision.routingMode === 'blocked' || (scamResult.isScam && scamResult.confidence >= 80) || throttled)) {
    await markGuardianCallbackProcessed(supabase, smsSid);
    return new NextResponse('', { status: 200 });
  }

  // Notify the family member.
  const callerDisplay = decision.contactName ?? formatPhone(from);
  const preview = body.length > 100 ? `${body.slice(0, 100)}…` : body;

  try {
    // Same shape and same reason as the SMS route: a routine screened message
    // obeys quiet hours. An emergency does not wait for morning.
    const scope = await systemScopeForFamily(supabase, familyId);
    if (scope) {
      await notify(scope, {
        recipients: 'family',
        type: 'system',
        title: emergency ? `🚨 Emergency WhatsApp from ${callerDisplay}` : `💚 WhatsApp from ${callerDisplay}`,
        body: preview,
        relatedType: 'guardian_communications',
        relatedId: comm?.id ?? null,
        ...(emergency ? { urgent: true } : {}),
      });
    }
  } catch { /* non-fatal */ }

  if (emergency) {
    // Text and call the managers, keyed on the communication (or, if it was not
    // recorded, on the message itself) so a redelivery cannot alarm twice.
    try {
      const escalation = await escalateGuardianEmergency(supabase, {
        familyId,
        ...(comm?.id ? { commId: comm.id as string } : {}),
        escalationType: 'urgent_personal',
        severity: 'critical',
        description: `Emergency WhatsApp from ${callerDisplay}: "${body.slice(0, 300)}"`,
        ...(from ? { callerNumber: from.slice(0, 64) } : {}),
      });
      if (escalation.kind !== 'delivered' && escalation.kind !== 'duplicate') {
        console.error('[guardian/inbound/whatsapp] emergency escalation did not reach a manager', { familyId, smsSid, outcome: escalation.kind });
      }
    } catch (error) {
      console.error('[guardian/inbound/whatsapp] emergency escalation threw', { familyId, smsSid, error });
    }
  }

  await markGuardianCallbackProcessed(supabase, smsSid);
  return new NextResponse('', { status: 200 });
}
