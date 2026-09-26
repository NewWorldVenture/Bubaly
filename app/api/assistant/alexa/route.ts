import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readBoundedRequestBytes } from '@/lib/server/bounded-request-body';
import { clientIp, rateLimit } from '@/lib/server/rate-limit';
import { rateLimitDb } from '@/lib/server/rate-limit-db';
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
  // In-memory, and before anything touches the database. An unverified request
  // must not reach it — the property tests/alexa-request-verification.test.ts
  // pins, and which any durable, service-role-backed limiter placed here would
  // break by writing a rate-limit row for a request whose signature has not
  // been checked.
  //
  // This branch previously ran a durable half after verification but BEFORE the
  // access token was read, so a request carrying no token still caused a
  // service-role write. That placement is gone for good. A module-scope Map is
  // per-lambda and the caller sets the number of lambdas by sending in
  // parallel, so this one is a cheap pre-filter; the durable per-CALLER limit
  // is after resolveAssistantLink, where there is a caller to key it on.
  const tooMany = () => NextResponse.json(alexaSpeechResponse('Too many requests right now. Try again shortly.'));
  const rateKey = `assistant-alexa:${clientIp(req.headers)}`;
  if (!rateLimit(rateKey, { limit: 60, windowMs: 60_000 }).ok) return tooMany();

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

  // The durable half, keyed on the link rather than the IP, and deliberately
  // placed after BOTH gates this route has — Amazon's signature and the access
  // token. See the twin note in app/api/assistant/route.ts for why it cannot
  // live at the top, and why it fails open.
  //
  // The limit is 60 here against the sibling's 30 because one spoken exchange
  // can be several Alexa requests (a LaunchRequest, then the intent), where the
  // token endpoint takes one POST per utterance.
  const durable = await rateLimitDb(supabase, `assistant-alexa:${link.id}`, {
    limit: 60, windowMs: 60_000, failOpen: true,
  });
  // Spoken, not a 429: a non-200 makes the device say "there was a problem with
  // the requested skill's response", which tells the person nothing about why.
  if (!durable.ok) return tooMany();

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
