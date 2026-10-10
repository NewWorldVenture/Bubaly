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
import { claimGuardianCallback, isValidGuardianEventId, markGuardianCallbackError, markGuardianCallbackProcessed, releaseGuardianCallback } from '@/lib/guardian/callbacks';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { escalateGuardianEmergency, type GuardianEscalationOutcome } from '@/lib/guardian/escalate';
import { GUARDIAN_INBOUND_CAP_REASON, GUARDIAN_INBOUND_FAMILY_CAP, GUARDIAN_INBOUND_SENDER_CAP, GUARDIAN_INBOUND_WINDOW_MS } from '@/lib/guardian/inbound-caps';
import { wroteNoRows } from '@/lib/supabase/errors';

export const runtime = 'nodejs';

const MAX_TWILIO_BODY_BYTES = 64 * 1024;
/**
 * The emergency escalation texts AND calls every manager (fanned out together,
 * two Twilio requests of up to 15 s each) around a few database round-trips.
 * Awaited here with no bound, a slow provider held the webhook open for as
 * long as it liked; now the fan-out stops at this deadline (or the request's
 * own), and a cut-off is `interrupted`, never a success.
 */
const ESCALATION_MS = 30_000;

type InboundCap = { sender: boolean; family: boolean; unreadable: boolean };
const UNDER_CAP: InboundCap = { sender: false, family: false, unreadable: false };
/** A count that could not be read: the model call is withheld, the delivery is not. */
const UNREADABLE_CAP: InboundCap = { sender: false, family: false, unreadable: true };

/**
 * Whether this sender, and whether this family, is past the rolling inbound
 * cap (the same caps as the SMS lane). The message was RECORDED before it is
 * counted, so the count includes it and the comparison is `>`, as in the SMS
 * lane. A count that cannot be read used to read as zero, which bought the
 * model call exactly when the database was slow or refusing; it now reads as
 * unreadable, and an unreadable cap withholds the model call and nothing else.
 */
async function overInboundCap(supabase: ReturnType<typeof createServiceClient>, familyId: string, from: string | null): Promise<InboundCap> {
  const since = new Date(Date.now() - GUARDIAN_INBOUND_WINDOW_MS).toISOString();
  const count = async (sender: boolean): Promise<number | null> => {
    try {
      let query = supabase.from('guardian_communications').select('id', { count: 'exact', head: true })
        .eq('family_id', familyId).eq('comm_type', 'whatsapp_inbound').gte('started_at', since);
      if (sender) query = from === null ? query.is('from_number', null) : query.eq('from_number', from);
      const { count: n, error } = await query;
      return !error && typeof n === 'number' ? n : null;
    } catch { return null; }
  };
  const [fromSender, forFamily] = await Promise.all([count(true), count(false)]);
  if (fromSender === null || forFamily === null) return UNREADABLE_CAP;
  return { sender: fromSender > GUARDIAN_INBOUND_SENDER_CAP, family: forFamily > GUARDIAN_INBOUND_FAMILY_CAP, unreadable: false };
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

  // The profile names a member, but nothing in the database ties that member to
  // the profile's family (a plain FK to family_members.id), and every write
  // below runs with the service role. So check the member really is this
  // family's, and still in it, before the message is recorded under them or
  // the family told — the voice route refuses the same case before it routes,
  // and the SMS lane in ownsDestination. A removed member's profile is not
  // deactivated by the removal, so without this their messages kept arriving.
  const { data: owner, error: ownerError } = await supabase.from('family_members')
    .select('id, family_id').eq('id', memberId).eq('family_id', familyId).eq('is_active', true).maybeSingle();
  if (ownerError) {
    console.error('[guardian-whatsapp] Guardian member lookup failed', { familyId, memberId, error: ownerError });
    await releaseGuardianCallback(supabase, 'inbound_whatsapp', smsSid);
    return new NextResponse('Guardian routing unavailable', { status: 503 });
  }
  if (!owner || (owner as { family_id?: string }).family_id !== familyId) {
    console.error('[guardian-whatsapp] Guardian number names a member outside its family; refusing the message', { familyId, memberId, to });
    await markGuardianCallbackProcessed(supabase, smsSid);
    return new NextResponse('', { status: 200 });
  }

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

  // No model call where the answer cannot change anything: the sender is
  // already blocked, or the pattern detector is already sure.
  const settled = decision.routingMode === 'blocked' || (decision.scamDetected && decision.spamScore >= 80);
  const patternVerdict = { isScam: decision.scamDetected, scamType: decision.scamType, confidence: decision.scamDetected ? Math.min(100, Math.max(0, decision.spamScore)) : 0 };

  // Create communication record — BEFORE the cap is counted and the model is
  // asked, with the pipeline's decision and the pattern detector's verdict;
  // the scam verdict and the status are filled in below once decided.
  //
  // Recording first is what makes the cap a cap. Counted first, two deliveries
  // arriving together at one under the cap both read "under" and both bought a
  // model call; recorded first, each delivery's own row is in the count it
  // reads (the SMS lane's order). It also means a message that could not be
  // recorded cannot be counted, and an uncounted message buys no model call.
  //
  // The voice twin of this (`inbound/voice/route.ts`) has the same defect and
  // the same reasoning: a dropped error means the message is delivered but
  // never recorded, so the family's guardian history silently loses the
  // entry. Here it also reaches the notification below as `relatedId:
  // comm?.id ?? null`, so the family gets an alert that links back to nothing.
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
    ai_decision_reason: decision.reason,
    scam_detected: patternVerdict.isScam,
    scam_type: patternVerdict.scamType,
    scam_confidence: patternVerdict.confidence,
    twilio_sms_sid: smsSid,
    status: 'screening',
  }).select('id').maybeSingle();

  if (commError) {
    console.error('[guardian/inbound/whatsapp] could not record the communication; message continues unlogged', {
      familyId, smsSid, error: commError.message,
    });
  }

  // Deep scam analysis on the message body — none past the rolling per-sender
  // / per-family cap, so a spamming sender cannot buy one LLM request per text,
  // and none when the cap cannot be read or this message is not in it. Past
  // the per-sender cap only a sender the family has not vouched for is HELD: a
  // contact at a ring-through trust level (immediate family, close family,
  // trusted friend) is still delivered, as in the SMS lane. The family-wide
  // flood cap holds for everyone.
  const cap = settled ? UNDER_CAP : comm?.id ? await overInboundCap(supabase, familyId, from) : UNREADABLE_CAP;
  const modelCapped = cap.sender || cap.family || cap.unreadable;
  const throttled = cap.family || (cap.sender && !shouldRingImmediately(decision.trustLevel));
  const scamResult = settled || modelCapped
    ? patternVerdict
    : await detectScamWithAI(body, from, `Family ID: ${familyId}`);
  const emergency = decision.shouldEscalate;
  const status = emergency ? 'escalated' : (scamResult.isScam && scamResult.confidence >= 80) || throttled ? 'blocked' : 'received';

  if (comm?.id) {
    // The decision, onto the row recorded above. A routine message past the
    // cap is recorded as `blocked`, and the reason says why: kept in the inbox,
    // no family alert. Confirmed and logged, never raised: the message is
    // delivered either way.
    const { data: decided, error: decideError } = await supabase.from('guardian_communications').update({
      ai_decision_reason: throttled ? `${decision.reason} ${GUARDIAN_INBOUND_CAP_REASON}` : decision.reason,
      scam_detected: scamResult.isScam,
      scam_type: scamResult.scamType,
      scam_confidence: scamResult.confidence,
      status,
    }).eq('id', comm.id as string).eq('family_id', familyId).select('id');
    if (decideError || wroteNoRows(decided)) {
      console.error('[guardian/inbound/whatsapp] could not save the decision on the recorded message', {
        familyId, smsSid, error: decideError?.message ?? 'no rows updated',
      });
    }
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
    let outcome: GuardianEscalationOutcome['kind'] | 'threw';
    try {
      const escalation = await escalateGuardianEmergency(supabase, {
        familyId,
        ...(comm?.id ? { commId: comm.id as string } : {}),
        escalationType: 'urgent_personal',
        severity: 'critical',
        description: `Emergency WhatsApp from ${callerDisplay}: "${body.slice(0, 300)}"`,
        ...(from ? { callerNumber: from.slice(0, 64) } : {}),
      }, { signal: AbortSignal.any([req.signal, AbortSignal.timeout(ESCALATION_MS)]) });
      outcome = escalation.kind;
    } catch (error) {
      console.error('[guardian/inbound/whatsapp] emergency escalation threw', { familyId, smsSid, error });
      outcome = 'threw';
    }
    if (outcome === 'undelivered' || outcome === 'interrupted') {
      // Nobody's phone was reached, and the escalation is on record saying so.
      // This used to be logged and the callback marked processed with a 200 —
      // after which nothing anywhere would try again. Now the callback is
      // parked as `error`, not processed: a redelivery inside ten minutes is
      // acknowledged without a second record or ping, the 503 says the message
      // was not handled, and the sweep on the Guardian recovery cron re-attempts
      // the escalation from its record until a manager is reached.
      console.error('[guardian/inbound/whatsapp] emergency escalation did not reach a manager; left for the retry sweep', { familyId, smsSid, outcome });
      await markGuardianCallbackError(supabase, smsSid, 'Emergency escalation reached no manager.');
      return new NextResponse('Escalation undelivered', { status: 503 });
    }
    if (outcome === 'claim_unavailable' || outcome === 'read_failed' || outcome === 'threw') {
      // Nothing was recorded by the escalation, so no sweep can find it: only
      // a redelivery can retry it. Give the claim back so the redelivery is
      // processed rather than acknowledged; the unique message sid keeps it
      // from recording the message twice, and the escalation's own claim keeps
      // it from alarming twice.
      console.error('[guardian/inbound/whatsapp] emergency escalation could not run; releasing the callback for a retry', { familyId, smsSid, outcome });
      await releaseGuardianCallback(supabase, 'inbound_whatsapp', smsSid);
      return new NextResponse('Escalation unavailable', { status: 503 });
    }
    if (outcome === 'record_failed') {
      // The alerts went out; only the record failed. Logged, and the message
      // is complete.
      console.error('[guardian/inbound/whatsapp] emergency escalation went out but could not be recorded', { familyId, smsSid });
    }
    if (outcome === 'unreachable') {
      // Nobody to text or call (no manager with a phone on file, or Twilio not
      // configured): recorded with nobody reached, and nothing to retry — a
      // redelivery or the sweep would find the same. Logged, and the message is
      // complete; it is not parked for the sweep as `undelivered` is.
      console.error('[guardian/inbound/whatsapp] emergency escalation had nobody to text or call; recorded with nobody reached', { familyId, smsSid });
    }
  }

  await markGuardianCallbackProcessed(supabase, smsSid);
  return new NextResponse('', { status: 200 });
}
