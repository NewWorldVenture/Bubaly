// app/api/guardian/inbound/voice/route.ts
// Twilio webhook — called when an inbound call arrives on a Bubaly Guardian number.
// Runs the decision pipeline and responds with TwiML within the 5-second window.

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { runDecisionPipeline } from '@/lib/guardian/pipeline';
import { buildInitialGreeting, buildVoicemailPrompt } from '@/lib/guardian/ai-screen';
import {
  wrapTwiml, twimlSay, twimlGather, twimlRecord, twimlDial, twimlHangup,
  validateTwilioSignature, lookupCallerName,
} from '@/lib/guardian/twilio';
import { formatPhone } from '@/lib/guardian/phone';
import { detectScamFromText } from '@/lib/guardian/scam';

export const runtime = 'nodejs';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';

export async function POST(req: NextRequest) {
  // Parse Twilio form data
  const formData = await req.formData();
  const params = Object.fromEntries(formData.entries()) as Record<string, string>;

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

  const supabase = createServiceClient();
  const db = withGuardianTables(supabase);
  const gFrom = (t: Parameters<typeof db.from>[0]) => (db.from(t) as ReturnType<typeof supabase.from>);

  // Find which family/member this number belongs to
  const { data: memberProfile } = await gFrom('guardian_member_profiles')
    .select('id, family_id, member_id, ai_persona_name, ai_greeting_template, current_context, default_mode_immediate, default_mode_close, default_mode_trusted, default_mode_known, default_mode_unknown, default_mode_suspected_spam, default_mode_blocked, context_overrides, voicemail_greeting, guardian_phone')
    .eq('guardian_phone', to)
    .eq('is_active', true)
    .maybeSingle();

  if (!memberProfile) {
    // Unknown number — just record to voicemail
    return twimlResponse(wrapTwiml(
      twimlRecord({
        action: `${BASE_URL}/api/guardian/status/voicemail`,
        text: 'Hello! Please leave a message and we\'ll get back to you.',
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
  const { data: comm } = await gFrom('guardian_communications').insert({
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
    return twimlResponse(wrapTwiml(
      twimlSay('I\'m sorry, we\'re not able to take this call. Goodbye.'),
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
      return twimlResponse(wrapTwiml(
        twimlSay(`Connecting you now. One moment please.`),
        twimlDial(memberPhone, to ?? undefined),
      ));
    }
    // Member has no phone configured — fall through to AI screening
  }

  if (routingMode === 'voicemail_first') {
    const prompt = buildVoicemailPrompt(profile, memberName);
    await updateCommStatus(supabase, commId, 'handled');
    return twimlResponse(wrapTwiml(
      twimlRecord({
        action: `${BASE_URL}/api/guardian/status/voicemail?commId=${commId ?? ''}`,
        text: prompt,
        maxLength: 120,
      }),
    ));
  }

  if (routingMode === 'silent_handling' || routingMode === 'ai_handle_first') {
    // Create screening session
    const { data: session } = await gFrom('guardian_screening_sessions').insert({
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

    return twimlResponse(wrapTwiml(
      twimlGather({
        action: `${BASE_URL}/api/guardian/screen?sessionId=${sessionId ?? ''}&turn=1`,
        text: greeting,
        timeout: 8,
        speechTimeout: 'auto',
      }),
      // If caller doesn't speak, prompt again
      twimlSay('I didn\'t catch that. Please try again.'),
      twimlHangup(),
    ));
  }

  // Default fallback
  return twimlResponse(wrapTwiml(
    twimlSay('Thank you for calling. We\'ll get back to you soon. Goodbye.'),
    twimlHangup(),
  ));
}

async function updateCommStatus(supabase: ReturnType<typeof createServiceClient>, commId: string | undefined, status: string) {
  if (!commId) return;
  const db = withGuardianTables(supabase);
  await (db.from('guardian_communications') as ReturnType<typeof supabase.from>).update({ status }).eq('id', commId);
}

function twimlResponse(xml: string): NextResponse {
  return new NextResponse(xml, {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}
