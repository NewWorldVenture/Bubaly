import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { clientIp, rateLimit } from '@/lib/server/rate-limit';
import { rateLimitDb } from '@/lib/server/rate-limit-db';
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
  // TWO limits, and which one sits where is the whole design.
  //
  // This one is in-memory and runs BEFORE any service-role client is
  // constructed. That ordering is load-bearing: a durable limiter writes
  // through the service role, so running one here would let an UNAUTHENTICATED
  // request cause a service-role write and make 429 the answer to a request
  // that was never authenticated. This branch tried exactly that and
  // tests/middleware-assistant-boundary.test.ts caught it.
  //
  // What this one is FOR is not token guessing. An earlier comment claimed it
  // stopped an attacker testing guessed tokens at speed, and that was wrong
  // twice over: a module-scope Map means "30 per minute" is 30 per minute PER
  // INSTANCE and the caller sets the instance count by sending in parallel,
  // and a link token is 32 CSPRNG bytes stored as a SHA-256
  // (lib/assistant/link-token.ts), so the keyspace is what defends it. This is
  // a cheap pre-filter on COST — it bounds how many unauthenticated requests
  // reach the one indexed SELECT below, per instance.
  //
  // The durable one is after `resolveAssistantLink`, where the caller has
  // proved which link they hold. See the note there.
  //
  // Both limiters refuse through this, so the two answers are identical by
  // construction rather than by two literals somebody has to keep in step —
  // the caller cannot tell which limit it hit, which is the right amount to
  // say. The Alexa route has the same helper for the same reason.
  const tooMany = (retryAfter: number) => NextResponse.json(
    { error: 'Too many requests' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );

  const limited = rateLimit(`assistant:${clientIp(req.headers)}`, { limit: 30, windowMs: 60_000 });
  if (!limited.ok) return tooMany(limited.retryAfter);

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

  // The durable half, and it is HERE for the reason the note at the top gives:
  // `rateLimitDb` writes through the service role, so at the top it would bill
  // a request that had proved nothing. After `resolveAssistantLink` the caller
  // has proved which link they hold, so the key is the PRINCIPAL rather than an
  // IP — a strictly better key, since an IP is something a caller can spread
  // across hosts and a link id is not.
  //
  // This is what makes the pair a real limit: the expensive half of this route
  // is `answerAssistant`, which reads the family and calls a model, and that
  // half is now bounded across instances rather than per lambda.
  //
  // `failOpen: true`, deliberately. If the limiter itself cannot be read, the
  // choice is between refusing every family's assistant and falling back to the
  // in-memory bound above. Failing open degrades to exactly the behaviour this
  // route had before the durable half existed; failing closed turns a
  // rate-limit outage into "Bubaly is not responding" in every kitchen. The
  // in-memory limiter is still in front, so open here is bounded, not unbounded.
  const durable = await rateLimitDb(supabase, `assistant:${link.id}`, {
    limit: 30, windowMs: 60_000, failOpen: true,
  });
  if (!durable.ok) return tooMany(durable.retryAfter);


  const utterance = typeof payload.utterance === 'string' ? payload.utterance.slice(0, MAX_UTTERANCE_CHARS) : '';
  const intent = classifyAssistantUtterance(utterance, new Date(), link.timezone);
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
