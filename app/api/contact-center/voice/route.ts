// Twilio inbound-voice webhook for a family's dedicated Contact Center number.
// The AI concierge answers with the family's greeting and takes a message; the
// transcription is routed into the unified inbox by the transcribeCallback.
// If the concierge is off and a fallback number is set, the call is forwarded.

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import {
  validateTwilioSignature, wrapTwiml, twimlSay, twimlDial, twimlRecord, twimlHangup,
} from '@/lib/guardian/twilio';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { resolveFamilyByNumber, getOrCreateChannel } from '@/lib/contact-center/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
const MAX_BODY = 64 * 1024;

function twiml(body: string): NextResponse {
  return new NextResponse(body, { status: 200, headers: { 'content-type': 'text/xml' } });
}

export async function POST(req: NextRequest) {
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
  const familyId = to ? await resolveFamilyByNumber(admin, to) : null;
  if (!familyId) {
    return twiml(wrapTwiml(twimlSay('This number is not in service.'), twimlHangup()));
  }

  const [channel, { data: fam }] = await Promise.all([
    getOrCreateChannel(admin, familyId),
    admin.from('families').select('name').eq('id', familyId).maybeSingle(),
  ]);
  const familyLabel = fam?.name || 'this family';

  // Concierge off → forward to the human fallback if set, else take a message.
  if (channel?.ai_concierge_enabled === false) {
    if (channel.forward_to_phone) {
      return twiml(wrapTwiml(twimlSay('Please hold while I connect you.'), twimlDial(channel.forward_to_phone, to)));
    }
  }

  const greeting = channel?.ai_greeting
    || `Hello, you've reached ${familyLabel}'s Bubaly assistant. I can take a message and make sure they get it.`;

  return twiml(wrapTwiml(
    twimlSay(greeting),
    twimlRecord({
      transcribeCallback: `${BASE_URL}/api/contact-center/voice/transcription?familyId=${familyId}`,
      text: 'Please leave your message after the tone, then hang up.',
      maxLength: 120,
    }),
    twimlSay('Thanks — I’ll pass that along. Goodbye.'),
    twimlHangup(),
  ));
}
