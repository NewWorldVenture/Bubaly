// app/api/guardian/escalate/twiml/route.ts
// TwiML for outbound emergency alert calls to parents.

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { wrapTwiml, twimlSay, twimlPause, twimlHangup } from '@/lib/guardian/twilio';
import { twilioRefusal, verifyTwilioRequest } from '@/lib/server/twilio-ingress';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

const MAX_TWILIO_BODY_BYTES = 64 * 1024;

// Only Twilio should fetch this (it renders speech for OUR outbound emergency
// calls) — the signature is what stops it being used as an open
// text-to-TwiML reflector, so it is checked on every request rather than only
// in a production build.
function refuse(req: NextRequest, params: Record<string, string>): NextResponse | null {
  const verdict = verifyTwilioRequest(req, params, 'guardian/escalate/twiml');
  return verdict.ok ? null : twilioRefusal(verdict);
}

async function render(req: NextRequest): Promise<NextResponse> {
  const t = await getTranslations();
  const { searchParams } = new URL(req.url);
  const msg = searchParams.get('msg') ?? 'Your family has an emergency call that needs attention.';

  const twiml = wrapTwiml(
    twimlSay(t('twiml.thisIsAnEmergencyAlert')),
    twimlPause(1),
    twimlSay(msg),
    twimlPause(1),
    twimlSay(t('twiml.pleaseCheckYourBubalyApp')),
    twimlPause(2),
    twimlSay(msg),
    twimlHangup(),
  );

  return new NextResponse(twiml, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

export async function GET(req: NextRequest) {
  // Twilio signs GET requests over the full URL with no body params.
  const refused = refuse(req, {});
  if (refused) return refused;
  return render(req);
}

export async function POST(req: NextRequest) {
  const boundedForm = await readBoundedRequestFormData(req, MAX_TWILIO_BODY_BYTES);
  if (!boundedForm.ok) return new NextResponse(boundedForm.reason === 'too_large' ? 'Payload too large' : 'Invalid callback', { status: boundedForm.reason === 'too_large' ? 413 : 400 });
  const params = Object.fromEntries(boundedForm.value.entries()) as Record<string, string>;
  const refused = refuse(req, params);
  if (refused) return refused;
  return render(req);
}
