// app/api/guardian/screen/route.ts
// Twilio Gather callback — called each time the caller speaks during AI screening.
// Continues the conversation or ends it with a decision.

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { screeningTurn, summarizeScreening, type ScreeningTurn, type ScreeningDecision } from '@/lib/guardian/ai-screen';
import {
  wrapTwiml, twimlSay, twimlGather, twimlRecord, twimlDial, twimlHangup,
  sendSms,
} from '@/lib/guardian/twilio';
import { twilioRefusal, verifyTwilioRequest } from '@/lib/server/twilio-ingress';
import { formatPhone } from '@/lib/guardian/phone';
import { detectScamFromText } from '@/lib/guardian/scam';
import type { MemberProfile } from '@/lib/guardian/pipeline';
import { isNextScreeningTurn } from '@/lib/guardian/screening-turn';
import { claimGuardianCallback, isValidGuardianEventId, markGuardianCallbackProcessed, releaseGuardianCallback } from '@/lib/guardian/callbacks';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { wroteNoRows } from '@/lib/supabase/errors';
import { appBaseUrl } from '@/lib/server/app-url';
import { escalateGuardianEmergency } from '@/lib/guardian/escalate';

export const runtime = 'nodejs';

// Where Twilio should call BACK: the `action`/`transcribeCallback` URLs embedded
// in the TwiML below. Verifying an INBOUND request no longer reads this — see
// lib/server/twilio-ingress.ts, which takes the signed URL from the request.
const BASE_URL = appBaseUrl();
const MAX_TWILIO_BODY_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  const tr = await getTranslations();
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('sessionId') ?? '';
  const turn = Number(searchParams.get('turn') ?? '1');

  const boundedForm = await readBoundedRequestFormData(req, MAX_TWILIO_BODY_BYTES);
  if (!boundedForm.ok) return new NextResponse(boundedForm.reason === 'too_large' ? 'Payload too large' : 'Invalid callback', { status: boundedForm.reason === 'too_large' ? 413 : 400 });
  const params = Object.fromEntries(boundedForm.value.entries()) as Record<string, string>;

  const verdict = verifyTwilioRequest(req, params, 'guardian/screen');
  if (!verdict.ok) return twilioRefusal(verdict);

  const speechResult = params.SpeechResult ?? '';
  const callSid = params.CallSid ?? '';

  if (!isValidGuardianEventId(sessionId) || !isValidGuardianEventId(callSid)
    || !Number.isInteger(turn) || turn < 1 || turn > 5 || speechResult.length > 4096) {
    return new NextResponse('Invalid callback', { status: 400 });
  }

  const supabase = createServiceClient();
  const callbackId = `${callSid}:screen:${turn}`;
  const claim = await claimGuardianCallback(supabase, 'screening_gather', callbackId);
  // Saying goodbye is right for a duplicate and wrong for an outage: it ends a
  // live screening call and reports success. A 503 lets Twilio fall back.
  if (claim === 'unavailable') return new NextResponse('', { status: 503 });
  if (claim !== 'claimed') return twimlResponse(wrapTwiml(twimlSay(tr('screen.thankYouForCallingGoodbye')), twimlHangup()));
  const finish = async (xml: string) => {
    await markGuardianCallbackProcessed(supabase, callbackId);
    return twimlResponse(xml);
  };

  // Load session.
  //
  // The rule for this exact situation is already written eleven lines above,
  // on the callback claim: *"Saying goodbye is right for a duplicate and wrong
  // for an outage: it ends a live screening call and reports success. A 503
  // lets Twilio fall back."* This read then dropped its error and did the
  // forbidden thing — a refused or failed read left `session` null and hung up
  // on a live screening call with a cheerful goodbye, which is indistinguishable
  // to the caller from being screened out. Guardian screens for scams against
  // the people least able to absorb one; the call it drops this way is as
  // likely to be a real grandchild as a fraudster. Audit C1-S9-39.
  const { data: session, error: sessionError } = await supabase.from('guardian_screening_sessions')
    .select('*, communication_id')
    .eq('id', sessionId)
    .maybeSingle();

  if (sessionError) {
    console.error('[guardian/screen] session read failed; letting Twilio fall back', { sessionId, error: sessionError.message });
    // Falling back only works if the fallback can take this turn: held, the
    // claim made it a 'settled' duplicate for ten minutes, said goodbye, and
    // hung up. Nothing has been written yet, so give it back.
    await releaseGuardianCallback(supabase, 'screening_gather', callbackId);
    return new NextResponse('', { status: 503 });
  }

  if (!session || (session as { status: string }).status !== 'active') {
    return finish(wrapTwiml(
      twimlSay(tr('screen.thankYouForCallingGoodbye')),
      twimlHangup(),
    ));
  }

  // Reject stale, skipped, malformed, or over-limit callbacks before any AI
  // work or service-role reads can be repeated by a Twilio retry/replay.
  const storedTurn = Number((session as { turn?: number }).turn ?? 0);
  if (!isNextScreeningTurn(storedTurn, turn)) {
    return finish(wrapTwiml(
      twimlSay(tr('screen.thankYouForCallingGoodbye')),
      twimlHangup(),
    ));
  }

  // `messages` is jsonb, so the row type says `Json`. The rows this route reads
  // are the ones it wrote, turn by turn, as ScreeningTurn[] — narrow through
  // `unknown` rather than widening the column's type for everyone.
  const sess = {
    ...session,
    messages: (session.messages ?? []) as unknown as ScreeningTurn[],
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
      twimlSay(tr('screen.weReNotInterestedThank')),
      twimlHangup(),
    ));
  }

  // Load member/family context for AI
  // The profile of the member THIS call was for. Profiles are per member
  // (unique on family_id + member_id), and this read used to ask for the
  // family's one profile: with two protected members it errored, the error was
  // dropped, and the AI screened without the member's settings, and a transfer
  // with no phone to dial went to voicemail. The communication names the member.
  let calledMemberId: string | null = null;
  if (sess.communication_id) {
    const { data: comm, error: commError } = await supabase.from('guardian_communications')
      .select('member_id').eq('id', sess.communication_id).eq('family_id', sess.family_id).maybeSingle();
    if (commError) {
      console.error('[guardian/screen] communication read failed; letting Twilio fall back', { sessionId, error: commError.message });
      await releaseGuardianCallback(supabase, 'screening_gather', callbackId);
      return new NextResponse('', { status: 503 });
    }
    calledMemberId = (comm as { member_id?: string | null } | null)?.member_id ?? null;
  }
  const profiles = supabase.from('guardian_member_profiles').select('*').eq('family_id', sess.family_id);
  const { data: profileRows, error: profileError } = await (calledMemberId ? profiles.eq('member_id', calledMemberId) : profiles).limit(2);
  if (profileError) {
    console.error('[guardian/screen] member profile read failed; letting Twilio fall back', { sessionId, error: profileError.message });
    await releaseGuardianCallback(supabase, 'screening_gather', callbackId);
    return new NextResponse('', { status: 503 });
  }
  // Without a named member, only an unambiguous profile is used.
  const memberProfile = profileRows?.length === 1 ? profileRows[0] : null;

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

  // Every write in this route runs inside a LIVE CALL: failing the webhook
  // drops the caller, so none of them may bail. But their results were
  // discarded whole, and this one matters most — it is the transcript the NEXT
  // turn reasons from, so a silent failure leaves the screening AI deciding on
  // a conversation that stops two turns ago. Confirmed and logged, never raised.
  // Audit C1-S9-63.
  const { data: historySaved, error: historyError } = await supabase.from('guardian_screening_sessions').update({
    messages: newHistory,
    turn,
    caller_name_stated: decision?.callerName ?? (session as { caller_name_stated?: string }).caller_name_stated,
  }).eq('id', sess.id).select('id');
  if (historyError || wroteNoRows(historySaved)) {
    console.error('[guardian/screen] transcript save failed; the next turn reasons from stale history', {
      sessionId: sess.id, turn, error: historyError?.message ?? 'no rows updated',
    });
  }

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
        twimlSay(responseText || tr('screen.thankYouGoodbye')),
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
          callerNumber: sess.caller_number,
        });
      }

      if (memberPhone) {
        return finish(wrapTwiml(
          twimlSay(responseText || tr('screen.connectingYouNowOneMoment')),
          twimlDial(memberPhone),
        ));
      }

      return finish(wrapTwiml(
        twimlSay('I’ll let them know you called. Please leave a message after the tone.'),
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
      // Logged, not raised, as above. Audit C1-S9-63.
      const { data: summarised, error: summaryError } = await supabase.from('guardian_communications')
        .update({ summary, status: 'handled' }).eq('id', sess.communication_id).select('id');
      if (summaryError || wroteNoRows(summarised)) {
        console.error('[guardian/screen] voicemail summary save failed', {
          commId: sess.communication_id, error: summaryError?.message ?? 'no rows updated',
        });
      }
      await notifyFamily(supabase, sess.family_id, memberProfile as { member_id: string } | null, {
        commId: sess.communication_id,
        callerName: decision?.callerName ?? formatPhone(sess.caller_number),
        summary,
        urgency: decision?.urgency ?? 'low',
        callerNumber: sess.caller_number,
      });
    }

    return finish(wrapTwiml(
      twimlSay(responseText || tr('screen.thankYouILlPass')),
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
    twimlSay(tr('screen.iDidnTCatchThat')),
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
  // The decision's own field types, not `string`. These land in columns with
  // CHECK constraints, so a value outside the set is rejected by Postgres at
  // write time and the session silently stays open. Taking the union here
  // makes that a compile error instead.
  finalAction: ScreeningDecision['action'],
  meta: {
    ai_risk: ScreeningDecision['risk'];
    ai_urgency: ScreeningDecision['urgency'];
    ai_intent: string;
    resolution_summary: string;
  },
) {

  // The session left unresolved stays "in progress" in the family's call log,
  // and the communication left unhandled keeps its risk unrecorded — which is
  // the one field a parent reviewing a scam call reads. Logged, never raised:
  // the caller is still on the line. Audit C1-S9-63.
  const { data: resolved, error: resolveError } = await supabase.from('guardian_screening_sessions').update({
    status: 'resolved',
    final_action: finalAction,
    ai_risk: meta.ai_risk,
    ai_urgency: meta.ai_urgency,
    ai_intent: meta.ai_intent,
    resolution_summary: meta.resolution_summary,
  }).eq('id', sessionId).select('id');
  if (resolveError || wroteNoRows(resolved)) {
    console.error('[guardian/screen] session resolve failed', { sessionId, error: resolveError?.message ?? 'no rows updated' });
  }

  if (commId) {
    const { data: handled, error: handledError } = await supabase.from('guardian_communications').update({
      status: 'handled',
      ai_decision_reason: meta.resolution_summary,
      sentiment: meta.ai_urgency === 'emergency' ? 'urgent' : meta.ai_risk.includes('scam') ? 'suspicious' : 'neutral',
    }).eq('id', commId).select('id');
    if (handledError || wroteNoRows(handled)) {
      console.error('[guardian/screen] communication handled-stamp failed', { commId, error: handledError?.message ?? 'no rows updated' });
    }
  }
}

async function notifyFamily(
  supabase: ReturnType<typeof createServiceClient>,
  familyId: string,
  memberProfile: { member_id: string } | null,
  opts: { commId: string; callerName: string; summary: string; urgency: string; callerNumber: string | null },
) {
  // Non-fatal, but not invisible: the insert RESOLVES with an error rather than
  // throwing, so this catch never saw a failed write and a screened emergency
  // call could reach nobody with nothing logged.
  try {
    const { error } = await supabase.from('notifications').insert({
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
    if (error) console.error('[guardian] screening notification write failed', error);
  } catch (error) {
    console.error('[guardian] screening notification write threw', error);
  }

  // An emergency the screening AI recognised is not just an in-app row: text
  // and call the managers. Keyed on the communication, so a retried turn is
  // answered by the escalation's own claim instead of alarming twice. Logged,
  // never raised — the caller is still on the line.
  if (opts.urgency === 'emergency') {
    try {
      const escalation = await escalateGuardianEmergency(supabase, {
        familyId,
        commId: opts.commId,
        escalationType: 'emergency_call',
        severity: 'critical',
        description: `Emergency call from ${opts.callerName}: ${opts.summary}`.slice(0, 4096),
        ...(opts.callerNumber ? { callerNumber: opts.callerNumber.slice(0, 64) } : {}),
      });
      if (escalation.kind !== 'delivered' && escalation.kind !== 'duplicate') {
        console.error('[guardian/screen] emergency escalation did not reach a manager', { familyId, commId: opts.commId, outcome: escalation.kind });
      }
    } catch (error) {
      console.error('[guardian/screen] emergency escalation threw', { familyId, commId: opts.commId, error });
    }
  }
}

function twimlResponse(xml: string): NextResponse {
  return new NextResponse(xml, {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}
