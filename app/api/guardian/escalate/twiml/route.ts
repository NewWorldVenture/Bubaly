// app/api/guardian/escalate/twiml/route.ts
// TwiML for outbound emergency alert calls to parents.

import { NextRequest, NextResponse } from 'next/server';
import { wrapTwiml, twimlSay, twimlPause, twimlHangup, validateTwilioSignature } from '@/lib/guardian/twilio';

export const runtime = 'nodejs';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';

// Only Twilio should fetch this (it renders speech for OUR outbound emergency
// calls) — validate the request signature in production so it can't be used
// as an open text-to-TwiML reflector.
function authorized(req: NextRequest, params: Record<string, string>): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  const sig = req.headers.get('x-twilio-signature') ?? '';
  const url = `${BASE_URL}${req.nextUrl.pathname}${req.nextUrl.search}`;
  return validateTwilioSignature(sig, url, params);
}

function render(req: NextRequest): NextResponse {
  const { searchParams } = new URL(req.url);
  const msg = searchParams.get('msg') ?? 'Your family has an emergency call that needs attention.';

  const twiml = wrapTwiml(
    twimlSay('This is an emergency alert from Bubaly, your family AI assistant.'),
    twimlPause(1),
    twimlSay(msg),
    twimlPause(1),
    twimlSay('Please check your Bubaly app or call your family immediately. This message will repeat once.'),
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
  if (!authorized(req, {})) return new NextResponse('Unauthorized', { status: 401 });
  return render(req);
}

export async function POST(req: NextRequest) {
  const formData = await req.formData().catch(() => null);
  const params = formData ? (Object.fromEntries(formData.entries()) as Record<string, string>) : {};
  if (!authorized(req, params)) return new NextResponse('Unauthorized', { status: 401 });
  return render(req);
}
