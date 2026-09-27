// Twilio inbound-voice webhook for a family's dedicated Contact Center number.
// The AI concierge answers with the family's greeting and takes a message; the
// transcription is routed into the unified inbox by the transcribeCallback.
// If the concierge is off and a fallback number is set, the call is forwarded.

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import {
  validateTwilioSignature, wrapTwiml, twimlSay, twimlDial, twimlRecord, twimlHangup,
} from '@/lib/guardian/twilio';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { resolveFamilyByNumberResult, getOrCreateChannelResult } from '@/lib/contact-center/server';
import { toCallableE164 } from '@/lib/contact-center/phone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
const MAX_BODY = 64 * 1024;

function twiml(body: string): NextResponse {
  return new NextResponse(body, { status: 200, headers: { 'content-type': 'text/xml' } });
}

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const form = await readBoundedRequestFormData(req, MAX_BODY);
  if (!form.ok) return new NextResponse('Invalid callback', { status: form.reason === 'too_large' ? 413 : 400 });
  const params = Object.fromEntries(form.value.entries()) as Record<string, string>;

  if (process.env.NODE_ENV === 'production') {
    const sig = req.headers.get('x-twilio-signature') ?? '';
    if (!validateTwilioSignature(sig, `${BASE_URL}/api/contact-center/voice`, params)) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const to = params.To ?? '';
  const admin = createServiceClient();
  const routed = to ? await resolveFamilyByNumberResult(admin, to) : { familyId: null, error: null };
  if (routed.error) {
    console.error('[contact-center] voice routing read failed', routed.error);
    return new NextResponse('Routing temporarily unavailable', { status: 503 });
  }
  const familyId = routed.familyId;
  if (!familyId) {
    return twiml(wrapTwiml(twimlSay(t('voice.thisNumberIsNotIn')), twimlHangup()));
  }

  const [channelResult, familyResult] = await Promise.all([
    getOrCreateChannelResult(admin, familyId),
    settle(admin.from('families').select('name').eq('id', familyId).maybeSingle()),
  ]);
  if (channelResult.error || familyResult.error) {
    console.error('[contact-center] voice family context read failed', channelResult.error ?? familyResult.error);
    return new NextResponse('Contact Center temporarily unavailable', { status: 503 });
  }
  const channel = channelResult.data;
  const familyLabel = familyResult.data?.name || 'this family';

  // Concierge off → forward to the human fallback if set, else take a message.
  // A number saved before the settings form normalized it is still dialled
  // when it reads as one. A stored value that does not read as a number (a row
  // from before the form refused text; 0384 clears such rows) is not treated as
  // "no number": it goes into the <Dial> as it stands, escaped, so the document
  // still parses and the provider's own refusal of the noun is what fails — and
  // the message-taking verbs below follow it, because Twilio moves on to the
  // next verb when a <Dial> cannot connect, so the caller is asked for a message
  // rather than dropped.
  let legacyDial: string | null = null;
  if (channel?.ai_concierge_enabled === false && channel.forward_to_phone) {
    const forwardTo = toCallableE164(channel.forward_to_phone);
    if (forwardTo) {
      return twiml(wrapTwiml(twimlSay(t('voice.pleaseHoldWhileIConnect')), twimlDial(forwardTo, to)));
    }
    legacyDial = twimlDial(channel.forward_to_phone, to);
  }

  const greeting = channel?.ai_greeting
    || `Hello, you've reached ${familyLabel}'s Bubaly assistant. I can take a message and make sure they get it.`;

  return twiml(wrapTwiml(
    ...(legacyDial ? [legacyDial] : []),
    twimlSay(greeting),
    twimlRecord({
      transcribeCallback: `${BASE_URL}/api/contact-center/voice/transcription?familyId=${familyId}`,
      text: 'Please leave your message after the tone, then hang up.',
      maxLength: 120,
    }),
    twimlSay(t('voice.thanksILlPassThat')),
    twimlHangup(),
  ));
}
