// app/api/guardian/escalate/twiml/route.ts
// TwiML for outbound emergency alert calls to parents.

import { NextRequest, NextResponse } from 'next/server';
import { wrapTwiml, twimlSay, twimlPause, twimlHangup } from '@/lib/guardian/twilio';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
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

export async function POST(req: NextRequest) {
  return GET(req);
}
