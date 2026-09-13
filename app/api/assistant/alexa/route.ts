import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { clientIp, rateLimit } from '@/lib/server/rate-limit';
import { looksLikeAssistantToken } from '@/lib/assistant/link-token';
import { classifyAssistantUtterance } from '@/lib/assistant/intent';
import { ERROR_SPEECH } from '@/lib/assistant/answers';
import { answerAssistant, recordAssistantEvent, resolveAssistantLink } from '@/lib/assistant/service';
import {
  alexaAccessToken, alexaSilentResponse, alexaSpeechResponse, alexaUtterance,
  ALEXA_NOT_LINKED_SPEECH, type AlexaRequestBody,
} from '@/lib/assistant/alexa';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 24 * 1024; // Alexa envelopes are chatty.

// Alexa skill endpoint. Translates Alexa's envelope, then runs the same bridge
// as /api/assistant.
//
// Every reply here is HTTP 200 with speech in it, including the failures. A
// non-200 makes the device say "there was a problem with the requested skill's
// response", which tells the person nothing; a spoken sentence tells them
// whether they need to link an account or try again later.
export async function POST(req: NextRequest) {
  const limited = rateLimit(`assistant-alexa:${clientIp(req.headers)}`, { limit: 60, windowMs: 60_000 });
  if (!limited.ok) return NextResponse.json(alexaSpeechResponse('Too many requests right now. Try again shortly.'));

  const body = await readBoundedRequestJson(req, MAX_BODY_BYTES);
  if (!body.ok) return NextResponse.json(alexaSpeechResponse(ERROR_SPEECH));
  const envelope = (body.value ?? {}) as AlexaRequestBody;

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
