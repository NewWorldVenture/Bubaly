import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { clientIp, rateLimit } from '@/lib/server/rate-limit';
import { readPresentedToken } from '@/lib/assistant/link-token';
import { classifyAssistantUtterance } from '@/lib/assistant/intent';
import { ERROR_SPEECH } from '@/lib/assistant/answers';
import { answerAssistant, recordAssistantEvent, resolveAssistantLink } from '@/lib/assistant/service';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_UTTERANCE_CHARS = 500;

// The provider-agnostic assistant endpoint.
//
//   POST /api/assistant
//   Authorization: Bearer bub_asst_…
//   { "utterance": "what's on today" }
//
// Siri (via a Shortcut), Google Assistant (via a webhook action), Home
// Assistant, a Raspberry Pi, curl — anything that can make an HTTPS request
// speaks this. Alexa has its own envelope and gets /api/assistant/alexa, which
// translates and then calls the same code.
//
// Unauthenticated by design: the token IS the authorization, like the ICS feeds
// in 0034. It therefore runs on the service client and scopes everything to the
// family the token resolved to — no identifier from the request is trusted.
export async function POST(req: NextRequest) {
  // Rate limited by IP BEFORE the token lookup, so an attacker cannot use this
  // endpoint to test guessed tokens at speed.
  const limited = rateLimit(`assistant:${clientIp(req.headers)}`, { limit: 30, windowMs: 60_000 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  const body = await readBoundedRequestJson(req, MAX_BODY_BYTES);
  if (!body.ok) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: body.reason === 'too_large' ? 413 : 400 });
  }
  const payload = (body.value && typeof body.value === 'object' ? body.value : {}) as {
    utterance?: unknown; token?: unknown;
  };

  const token = readPresentedToken(req.headers.get('authorization'), payload.token);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const link = await resolveAssistantLink(supabase, token);
  // One answer for unknown, revoked and malformed alike: telling them apart
  // would make this a way to check whether a guessed token exists.
  if (!link) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const utterance = typeof payload.utterance === 'string' ? payload.utterance.slice(0, MAX_UTTERANCE_CHARS) : '';
  const intent = classifyAssistantUtterance(utterance);
  try {
    const reply = await answerAssistant(supabase, link, intent);
    await recordAssistantEvent(supabase, link, reply.intent, utterance, reply.outcome);
    return NextResponse.json({ speech: reply.speech, intent: reply.intent, outcome: reply.outcome });
  } catch (err) {
    console.error('[assistant] request failed', err);
    await recordAssistantEvent(supabase, link, intent.kind, utterance, 'error');
    // 200 with a spoken apology, not a 500: the caller is a speaker that will
    // read whatever comes back, and an HTTP error becomes "Bubaly is not
    // responding right now" in the user's kitchen with no idea what happened.
    return NextResponse.json({ speech: ERROR_SPEECH, intent: intent.kind, outcome: 'error' });
  }
}
