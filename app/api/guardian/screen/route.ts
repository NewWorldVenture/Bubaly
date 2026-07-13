// app/api/guardian/screen/route.ts
// Twilio Gather callback — called each time the caller speaks during AI screening.
// Continues the conversation or ends it with a decision.

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { screeningTurn, summarizeScreening, type ScreeningTurn } from '@/lib/guardian/ai-screen';
import {
  wrapTwiml, twimlSay, twimlGather, twimlRecord, twimlHangup,
  sendSms, validateTwilioSignature,
} from '@/lib/guardian/twilio';
import { formatPhone } from '@/lib/guardian/phone';
import { detectScamFromText } from '@/lib/guardian/scam';
import type { MemberProfile } from '@/lib/guardian/pipeline';
import { isNextScreeningTurn } from '@/lib/guardian/screening-turn';
import { claimGuardianCallback, isValidGuardianEventId, markGuardianCallbackProcessed } from '@/lib/guardian/callbacks';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';
const MAX_TWILIO_BODY_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('sessionId') ?? '';
  const turn = Number(searchParams.get('turn') ?? '1');

  const boundedForm = await readBoundedRequestFormData(req, MAX_TWILIO_BODY_BYTES);
  if (!boundedForm.ok) return new NextResponse(boundedForm.reason === 'too_large' ? 'Payload too large' : 'Invalid callback', { status: boundedForm.reason === 'too_large' ? 413 : 400 });
  const params = Object.fromEntries(boundedForm.value.entries()) as Record<string, string>;

  // Validate Twilio signature (skip in dev) — same guard as the inbound routes;
  // Twilio signs the FULL URL including the query string.
  if (process.env.NODE_ENV === 'production') {
    const sig = req.headers.get('x-twilio-signature') ?? '';
    const url = `${BASE_URL}${req.nextUrl.pathname}${req.nextUrl.search}`;
    if (!validateTwilioSignature(sig, url, params)) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const speechResult = params.SpeechResult ?? '';
  const callSid = params.CallSid ?? '';

  if (!isValidGuardianEventId(sessionId) || !isValidGuardianEventId(callSid)
    || !Number.isInteger(turn) || turn < 1 || turn > 5 || speechResult.length > 4096) {
    return new NextResponse('Invalid callback', { status: 400 });
  }

  const supabase = createServiceClient();
  const callbackId = `${callSid}:screen:${turn}`;
  const eventClaimed = await claimGuardianCallback(supabase, 'screening_gather', callbackId);
  if (!eventClaimed) return twimlResponse(wrapTwiml(twimlSay('Thank you for calling. Goodbye.'), twimlHangup()));
  const finish = async (xml: string) => {
    await markGuardianCallbackProcessed(supabase, callbackId);
    return twimlResponse(xml);
  };
  const db = withGuardianTables(supabase);
  const gFrom = (t: Parameters<typeof db.from>[0]) => (db.from(t) as ReturnType<typeof supabase.from>);

  // Load session
  const { data: session } = await gFrom('guardian_screening_sessions')
    .select('*, communication_id')
    .eq('id', sessionId)
    .maybeSingle();

  if (!session || (session as { status: string }).status !== 'active') {
    return finish(wrapTwiml(
      twimlSay('Thank you for calling. Goodbye.'),
      twimlHangup(),
    ));
  }

  // Reject stale, skipped, malformed, or over-limit callbacks before any AI
  // work or service-role reads can be repeated by a Twilio retry/replay.
  const storedTurn = Number((session as { turn?: number }).turn ?? 0);
  if (!isNextScreeningTurn(storedTurn, turn)) {
    return finish(wrapTwiml(
      twimlSay('Thank you for calling. Goodbye.'),
      twimlHangup(),
    ));
  }

  const sess = session as {
    id: string;
    family_id: string;
    communication_id: string | null;
    messages: ScreeningTurn[];
    caller_number: string | null;
    turn: number;
  };

  // Quick scam check on what caller said
  const scamCheck = detectScamFromText(speechResult, sess.caller_number ?? undefined);
  if (scamCheck.isScam && scamCheck.confidence >= 80) {
    await endScreening(supabase, sess.id, sess.communication_id, 'hang_up', {
      ai_risk: 'definite_scam',
      ai_urgency: 'low',
      ai_intent: 'scam',
      resolution_summary: `Scam detected (${scamCheck.scamType}). Call ended.`,
    });
    return finish(wrapTwiml(
      twimlSay('We\'re not interested. Thank you and goodbye.'),
      twimlHangup(),
    ));
  }

  // Load member/family context for AI
  const { data: memberProfile } = await gFrom('guardian_member_profiles')
    .select('*')
    .eq('family_id', sess.family_id)
    .maybeSingle();

  const { data: memberData } = memberProfile
    ? await supabase.from('family_members').select('display_name, phone').eq('id', (memberProfile as { member_id: string }).member_id).maybeSingle()
    : { data: null };
  const memberName = (memberData as { display_name?: string } | null)?.display_name ?? 'the family member';

  const { data: familyData } = await supabase.from('families').select('name').eq('id', sess.family_id).maybeSingle();
  const familyName = (familyData as { name?: string } | null)?.name ?? 'the family';

  const history: ScreeningTurn[] = Array.isArray(sess.messages) ? sess.messages : [];

  // Get AI response
  const { responseText, decision } = await screeningTurn({
    profile: memberProfile as MemberProfile | null,
    memberName,
    familyName,
    conversationHistory: history,
    callerInput: speechResult,
    turn,
  });

  // Append this exchange to conversation history
  const newHistory: ScreeningTurn[] = [
    ...history,
    { role: 'caller', content: speechResult },
    { role: 'assistant', content: responseText },
  ];

  await gFrom('guardian_screening_sessions').update({
    messages: newHistory,
    turn,
    caller_name_stated: decision?.callerName ?? (session as { caller_name_stated?: string }).caller_name_stated,
  }).eq('id', sess.id);

  // If AI reached a decision or max turns hit
  if (decision || turn >= 5) {
    const action = decision?.action ?? 'voicemail';

    if (action === 'hang_up' || (decision?.risk === 'definite_scam')) {
      await endScreening(supabase, sess.id, sess.communication_id, 'hang_up', {
        ai_risk: decision?.risk ?? 'suspicious',
        ai_urgency: decision?.urgency ?? 'low',
        ai_intent: decision?.intent ?? 'other',
        resolution_summary: decision?.summary ?? 'Call ended by AI.',
      });
      return finish(wrapTwiml(
        twimlSay(responseText || 'Thank you. Goodbye.'),
        twimlHangup(),
      ));
    }

    if (action === 'transfer') {
      const memberPhone = (memberData as { phone?: string } | null)?.phone;
      await endScreening(supabase, sess.id, sess.communication_id, 'transfer', {
        ai_risk: decision?.risk ?? 'safe',
        ai_urgency: decision?.urgency ?? 'medium',
        ai_intent: decision?.intent ?? 'personal',
        resolution_summary: decision?.summary ?? 'Call transferred.',
      });

      // Notify parent via push notification
      if (sess.communication_id) {
        await notifyFamily(supabase, sess.family_id, memberProfile as { member_id: string } | null, {
          commId: sess.communication_id,
          callerName: decision?.callerName ?? formatPhone(sess.caller_number),
          summary: decision?.summary ?? 'Incoming call transferred.',
          urgency: decision?.urgency ?? 'medium',
        });
      }

      if (memberPhone) {
        return finish(wrapTwiml(
          twimlSay(responseText || 'Connecting you now. One moment.'),
          `<Dial>${memberPhone}</Dial>`,
        ));
      }

      return finish(wrapTwiml(
        twimlSay('I\'ll let them know you called. Please leave a message after the tone.'),
        twimlRecord({
          action: `${BASE_URL}/api/guardian/status/voicemail?commId=${sess.communication_id ?? ''}`,
          text: '',
          maxLength: 120,
        }),
      ));
    }

    // voicemail / notify
    await endScreening(supabase, sess.id, sess.communication_id, 'voicemail', {
      ai_risk: decision?.risk ?? 'safe',
      ai_urgency: decision?.urgency ?? 'low',
      ai_intent: decision?.intent ?? 'other',
      resolution_summary: decision?.summary ?? 'Sent to voicemail.',
    });

    const summary = await summarizeScreening(newHistory, decision?.callerName ?? null, memberName);
    if (sess.communication_id) {
      await gFrom('guardian_communications').update({ summary, status: 'handled' }).eq('id', sess.communication_id);
      await notifyFamily(supabase, sess.family_id, memberProfile as { member_id: string } | null, {
        commId: sess.communication_id,
        callerName: decision?.callerName ?? formatPhone(sess.caller_number),
        summary,
        urgency: decision?.urgency ?? 'low',
      });
    }

    return finish(wrapTwiml(
      twimlSay(responseText || 'Thank you. I\'ll pass along your message.'),
      twimlRecord({
        action: `${BASE_URL}/api/guardian/status/voicemail?commId=${sess.communication_id ?? ''}`,
        text: 'Please leave your message after the tone. Press any key when done.',
        maxLength: 120,
      }),
    ));
  }

  // Continue conversation
  return finish(wrapTwiml(
    twimlGather({
      action: `${BASE_URL}/api/guardian/screen?sessionId=${sess.id}&turn=${turn + 1}`,
      text: responseText,
      timeout: 8,
      speechTimeout: 'auto',
    }),
    twimlSay('I didn\'t catch that. Could you please repeat that?'),
    twimlGather({
      action: `${BASE_URL}/api/guardian/screen?sessionId=${sess.id}&turn=${turn + 1}`,
      text: '',
      timeout: 5,
    }),
    twimlHangup(),
  ));
}

async function endScreening(
  supabase: ReturnType<typeof createServiceClient>,
  sessionId: string,
  commId: string | null,
  finalAction: string,
  meta: { ai_risk: string; ai_urgency: string; ai_intent: string; resolution_summary: string },
) {
  const db = withGuardianTables(supabase);
  const gFrom = (t: Parameters<typeof db.from>[0]) => (db.from(t) as ReturnType<typeof supabase.from>);

  await gFrom('guardian_screening_sessions').update({
    status: 'resolved',
    final_action: finalAction,
    ai_risk: meta.ai_risk,
    ai_urgency: meta.ai_urgency,
    ai_intent: meta.ai_intent,
    resolution_summary: meta.resolution_summary,
  }).eq('id', sessionId);

  if (commId) {
    await gFrom('guardian_communications').update({
      status: 'handled',
      ai_decision_reason: meta.resolution_summary,
      sentiment: meta.ai_urgency === 'emergency' ? 'urgent' : meta.ai_risk.includes('scam') ? 'suspicious' : 'neutral',
    }).eq('id', commId);
  }
}

async function notifyFamily(
  supabase: ReturnType<typeof createServiceClient>,
  familyId: string,
  memberProfile: { member_id: string } | null,
  opts: { commId: string; callerName: string; summary: string; urgency: string },
) {
  try {
    await supabase.from('notifications').insert({
      family_id: familyId,
      user_id: null,
      type: 'system',
      title: opts.urgency === 'emergency'
        ? `🚨 Emergency call from ${opts.callerName}`
        : `📞 Call from ${opts.callerName}`,
      body: opts.summary,
      related_type: 'guardian_communications',
      related_id: opts.commId,
    });
  } catch { /* non-fatal */ }
}

function twimlResponse(xml: string): NextResponse {
  return new NextResponse(xml, {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}
