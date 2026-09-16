// app/api/guardian/inbound/voice/route.ts
// Twilio webhook — called when an inbound call arrives on a Bubaly Guardian number.
// Runs the decision pipeline and responds with TwiML within the 5-second window.

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { runDecisionPipeline } from '@/lib/guardian/pipeline';
import { buildInitialGreeting, buildVoicemailPrompt } from '@/lib/guardian/ai-screen';
import {
  wrapTwiml, twimlSay, twimlGather, twimlRecord, twimlDial, twimlHangup,
  validateTwilioSignature, lookupCallerName,
} from '@/lib/guardian/twilio';
import { formatPhone } from '@/lib/guardian/phone';
import { detectScamFromText } from '@/lib/guardian/scam';
import { claimGuardianCallback, isValidGuardianEventId, markGuardianCallbackProcessed } from '@/lib/guardian/callbacks';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import type { Database } from '@/lib/database.types';

export const runtime = 'nodejs';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';
const MAX_TWILIO_BODY_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  const tr = await getTranslations();
  // Parse Twilio form data
  const boundedForm = await readBoundedRequestFormData(req, MAX_TWILIO_BODY_BYTES);
  if (!boundedForm.ok) return new NextResponse(boundedForm.reason === 'too_large' ? 'Payload too large' : 'Invalid callback', { status: boundedForm.reason === 'too_large' ? 413 : 400 });
  const params = Object.fromEntries(boundedForm.value.entries()) as Record<string, string>;

  // Validate Twilio signature (skip in dev)
  if (process.env.NODE_ENV === 'production') {
    const sig = req.headers.get('x-twilio-signature') ?? '';
    const url = `${BASE_URL}/api/guardian/inbound/voice`;
    if (!validateTwilioSignature(sig, url, params)) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const callSid = params.CallSid ?? '';
  const from = params.From ?? null;
  const to = params.To ?? null;
  const callStatus = params.CallStatus ?? '';

  if (!callSid || callStatus === 'completed') {
    return twimlResponse(wrapTwiml(twimlHangup()));
  }
  // `To` is the Guardian number the message reached, and it is the ONLY thing
  // that resolves which family this belongs to. Without it the profile lookup
  // matches nothing and the callback is consumed anyway — so refuse it here,
  // before the claim, rather than after.
  if (!isValidGuardianEventId(callSid) || !to) {
    return new NextResponse('Invalid callback', { status: 400 });
  }

  const supabase = createServiceClient();
  const claim = await claimGuardianCallback(supabase, 'inbound_voice', callSid);
  // Hanging up is right for a duplicate and wrong for an outage: it ends a real
  // call and tells Twilio the callback succeeded. A 503 lets Twilio apply its
  // own fallback for the call instead of this route silently dropping it.
  if (claim === 'unavailable') return new NextResponse('', { status: 503 });
  if (claim !== 'claimed') return twimlResponse(wrapTwiml(twimlHangup()));
  const finish = async (xml: string) => {
    await markGuardianCallbackProcessed(supabase, callSid);
    return twimlResponse(xml);
  };

  // Find which family/member this number belongs to
  const { data: memberProfile, error: profileError } = await supabase.from('guardian_member_profiles')
    .select('id, family_id, member_id, ai_persona_name, ai_greeting_template, current_context, default_mode_immediate, default_mode_close, default_mode_trusted, default_mode_known, default_mode_unknown, default_mode_suspected_spam, default_mode_blocked, context_overrides, voicemail_greeting, guardian_phone')
    .eq('guardian_phone', to)
    .eq('is_active', true)
    .maybeSingle();

  // A FAILED lookup is not an unknown number. `maybeSingle()` answers
  // `data: null` plus PGRST116 when MORE THAN ONE profile holds this number —
  // which is exactly the state 0326's unique index exists to prevent, and which
  // a production database may already be in, because 0326 reports duplicates
  // rather than choosing which household loses its number. Dropping the error
  // turned that into "we do not know this number", and sent the caller to voicemail. Answering 5xx
  // instead leaves the event unconsumed so Twilio retries it, and puts the
  // reason somewhere a person can find.
  if (profileError) {
    console.error('[guardian-voice] Guardian number lookup failed', { to, error: profileError });
    // NOT `finish()`: that calls markGuardianCallbackProcessed, which is
    // precisely what must not happen here. The event has to stay unconsumed so
    // Twilio retries it once the duplicate is resolved.
    return new NextResponse(
      wrapTwiml(twimlSay('Sorry, we cannot take this call right now. Please try again shortly.')),
      { status: 503, headers: { 'content-type': 'application/xml; charset=utf-8' } },
    );
  }

  if (!memberProfile) {
    // Unknown number — just record to voicemail
    return finish(wrapTwiml(
      twimlRecord({
        action: `${BASE_URL}/api/guardian/status/voicemail`,
        text: 'Hello! Please leave a message and we’ll get back to you.',
        maxLength: 120,
      }),
    ));
  }

  const familyId = memberProfile.family_id as string;
  const memberId = memberProfile.member_id as string;

  // Enrich caller ID via Twilio Lookup (best-effort, non-blocking)
  const callerName = await lookupCallerName(from ?? '').catch(() => null);

  // Run the decision pipeline
  const decision = await runDecisionPipeline(supabase, {
    callerPhone: from,
    callerName,
    familyId,
    memberId,
    callSid,
  });

  // Create communication record
  const { data: comm } = await supabase.from('guardian_communications').insert({
    family_id: familyId,
    member_id: memberId,
    contact_id: decision.contactId,
    comm_type: 'call_inbound',
    direction: 'inbound',
    from_number: from,
    to_number: to,
    from_name: decision.contactName ?? callerName,
    trust_level_at_time: decision.trustLevel,
    routing_mode_used: decision.routingMode,
    routing_rule_id: decision.ruleId,
    ai_decision_reason: decision.reason,
    scam_detected: decision.scamDetected,
    scam_type: decision.scamType,
    scam_confidence: decision.spamScore,
    twilio_call_sid: callSid,
    status: 'received',
  }).select('id').single();

  const commId = comm?.id as string | undefined;

  // Route based on pipeline decision
  const { routingMode, memberProfile: profile } = decision;

  // Update member phone for display
  const memberData = await supabase.from('family_members').select('display_name').eq('id', memberId).maybeSingle();
  const memberName = (memberData.data as { display_name?: string } | null)?.display_name ?? 'the family';

  const { data: familyData } = await supabase.from('families').select('name').eq('id', familyId).maybeSingle();
  const familyName = (familyData as { name?: string } | null)?.name ?? 'the family';

  if (routingMode === 'blocked') {
    await updateCommStatus(supabase, commId, 'blocked');
    return finish(wrapTwiml(
      twimlSay(tr('voice.iMSorryWeRe')),
      twimlHangup(),
    ));
  }

  if (routingMode === 'immediate_ring' || routingMode === 'immediate_ai_summary') {
    // Ring through to the family member's actual number
    const { data: member } = await supabase.from('family_members').select('phone').eq('id', memberId).maybeSingle();
    const memberPhone = (member as { phone?: string } | null)?.phone;

    await updateCommStatus(supabase, commId, 'handled');

    if (memberPhone) {
      const callerDisplay = decision.contactName ?? formatPhone(from);
      return finish(wrapTwiml(
        twimlSay(`Connecting you now. One moment please.`),
        twimlDial(memberPhone, to ?? undefined),
      ));
    }
    // Member has no phone configured — fall through to AI screening
  }

  if (routingMode === 'voicemail_first') {
    const prompt = buildVoicemailPrompt(profile, memberName);
    await updateCommStatus(supabase, commId, 'handled');
    return finish(wrapTwiml(
      twimlRecord({
        action: `${BASE_URL}/api/guardian/status/voicemail?commId=${commId ?? ''}`,
        text: prompt,
        maxLength: 120,
      }),
    ));
  }

  if (routingMode === 'silent_handling' || routingMode === 'ai_handle_first') {
    // Create screening session
    const { data: session } = await supabase.from('guardian_screening_sessions').insert({
      family_id: familyId,
      communication_id: commId,
      twilio_call_sid: callSid,
      caller_number: from,
      status: 'active',
      messages: [],
    }).select('id').single();

    const sessionId = session?.id as string | undefined;
    const greeting = buildInitialGreeting(profile, memberName, familyName);

    await updateCommStatus(supabase, commId, 'screening');

    return finish(wrapTwiml(
      twimlGather({
        action: `${BASE_URL}/api/guardian/screen?sessionId=${sessionId ?? ''}&turn=1`,
        text: greeting,
        timeout: 8,
        speechTimeout: 'auto',
      }),
      // If caller doesn't speak, prompt again
      twimlSay(tr('voice.iDidnTCatchThat')),
      twimlHangup(),
    ));
  }

  // Default fallback
  return finish(wrapTwiml(
    twimlSay(tr('voice.thankYouForCallingWe')),
    twimlHangup(),
  ));
}

type CommStatus = Database['public']['Tables']['guardian_communications']['Row']['status'];

// `status` is CHECK-constrained in the database; take the column's own union so
// a typo is a compile error rather than a discarded update.
async function updateCommStatus(supabase: ReturnType<typeof createServiceClient>, commId: string | undefined, status: CommStatus) {
  if (!commId) return;
  await supabase.from('guardian_communications').update({ status }).eq('id', commId);
}

function twimlResponse(xml: string): NextResponse {
  return new NextResponse(xml, {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}
