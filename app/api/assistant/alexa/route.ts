import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readBoundedRequestBytes } from '@/lib/server/bounded-request-body';
import { clientIp, rateLimit } from '@/lib/server/rate-limit';
import { looksLikeAssistantToken } from '@/lib/assistant/link-token';
import { classifyAssistantUtterance } from '@/lib/assistant/intent';
import { ERROR_SPEECH } from '@/lib/assistant/answers';
import { answerAssistant, recordAssistantEvent, resolveAssistantLink } from '@/lib/assistant/service';
import {
  alexaAccessToken, alexaSilentResponse, alexaSpeechResponse, alexaUtterance,
  ALEXA_NOT_LINKED_SPEECH, type AlexaRequestBody,
} from '@/lib/assistant/alexa';
import { verifyAlexaRequest } from '@/lib/assistant/alexa-verify';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 24 * 1024; // Alexa envelopes are chatty.

// Alexa skill endpoint. Proves the request came from Amazon, translates the
// envelope, then runs the same bridge as /api/assistant.
//
// Two different failure shapes, and the difference is deliberate:
//
//   • A request that CANNOT BE PROVEN to come from Amazon gets a bare 403 and
//     no speech. It is not a device in somebody's kitchen, so there is nobody
//     to say anything to, and a spoken reply would confirm to whoever sent it
//     that the endpoint is live and what it thought of their envelope. Amazon's
//     own certification requires a non-2xx here too.
//   • Every failure AFTER that — not linked, no such thing on the calendar,
//     something broke — is HTTP 200 with speech in it. A non-200 makes the
//     device say "there was a problem with the requested skill's response",
//     which tells the person nothing; a spoken sentence tells them whether they
//     need to link an account or try again later.
export async function POST(req: NextRequest) {
  const limited = rateLimit(`assistant-alexa:${clientIp(req.headers)}`, { limit: 60, windowMs: 60_000 });
  if (!limited.ok) return NextResponse.json(alexaSpeechResponse('Too many requests right now. Try again shortly.'));

  // Bytes, not parsed JSON: the signature is over exactly what arrived. Parsing
  // and re-serialising would change whitespace and key order, and the signature
  // would never verify again.
  const raw = await readBoundedRequestBytes(req, MAX_BODY_BYTES);
  if (!raw.ok) return new NextResponse(null, { status: raw.reason === 'too_large' ? 413 : 400 });

  let envelope: AlexaRequestBody;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw.bytes));
    envelope = (parsed && typeof parsed === 'object' ? parsed : {}) as AlexaRequestBody;
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const verified = await verifyAlexaRequest({ headers: req.headers, rawBody: raw.bytes, body: envelope });
  if (!verified.ok) {
    // Logged, not spoken. The reason is for us.
    console.warn('[assistant/alexa] rejected unverified request', verified.reason);
    return new NextResponse(null, { status: 403 });
  }

  const translated = alexaUtterance(envelope);
  if (translated.kind === 'silent') return NextResponse.json(alexaSilentResponse());

  const token = alexaAccessToken(envelope);
  if (!token || !looksLikeAssistantToken(token)) {
    return NextResponse.json(alexaSpeechResponse(ALEXA_NOT_LINKED_SPEECH));
  }

  const supabase = createServiceClient();
  const link = await resolveAssistantLink(supabase, token);
  if (!link) return NextResponse.json(alexaSpeechResponse(ALEXA_NOT_LINKED_SPEECH));

  const intent = classifyAssistantUtterance(translated.utterance, new Date(), link.timezone);
  try {
    const reply = await answerAssistant(supabase, link, intent);
    await recordAssistantEvent(supabase, link, reply.intent, translated.utterance, reply.outcome);
    return NextResponse.json(alexaSpeechResponse(reply.speech));
  } catch (err) {
    console.error('[assistant/alexa] request failed', err);
    await recordAssistantEvent(supabase, link, intent.kind, translated.utterance, 'error');
    return NextResponse.json(alexaSpeechResponse(ERROR_SPEECH));
  }
}
