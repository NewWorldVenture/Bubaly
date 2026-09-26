import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { normalizeEmail, normalizeSource, normalizeVisitorId } from '@/lib/blog/engagement';
import { sendSubscribeNotice, type SubscribeOutcome } from '@/lib/blog/subscribe-notice';

export const runtime = 'nodejs';

// Public blog subscribe endpoint. An explicit email opt-in from the blog's
// subscribe forms → blog_subscribers (service-role only; RLS denies clients).
// Bot defenses: honeypot field (silently accepted, never written), IP rate
// limit, per-address mail throttle, bounded body, strict email normalization.
// Re-subscribing after an unsubscribe re-activates — a fresh explicit opt-in is
// new consent.
//
// EVERY ACCEPTED SUBMISSION GETS THE SAME ANSWER, AND THAT IS THE POINT.
//
// This handler used to answer `{ ok: true, already: true }` for an address on
// the list, `{ ok: true, already: false }` for one that had unsubscribed, and a
// bare `{ ok: true }` for one it had never seen. Nobody has to be signed in to
// ask, so that was a three-valued oracle over other people's email addresses,
// readable 20 times a minute per IP: is this person a reader, did they read and
// then leave, or have they never been here. The middle answer is the one worth
// stealing — it says someone deliberately opted out.
//
// The honeypot shared the defect from the other side. It answered a bare
// `{ ok: true }`, which is indistinguishable from a fresh subscribe but NOT
// from the `already` answer, so a bot that knew one subscribed address could
// submit it twice — once with `website` filled, once without — and the two
// answers named `website` as the trap.
//
// Both close the same way: one answer, `accepted()`, for every submission this
// endpoint takes. What is worth telling the person BEHIND the address is mailed
// to the address instead (lib/blog/subscribe-notice.ts), where only its owner
// can read it. The 400 above it is a property of the submitted string itself,
// which the caller can compute without us, and the 500 below it is the same
// sentence whichever write failed.
//
// Timing is kept boring rather than left to chance: every accepted address
// takes the same two rate-limit round trips, one lookup, exactly ONE write, and
// one mail dispatch, whatever state it was in. The honeypot is the one branch
// that answers without doing that work, and equalising it would mean writing
// bot rows or sleeping — the body it returns is identical, which is what the
// caller can actually read.

const MAX_BODY_BYTES = 4_096;

/**
 * The one answer. Built per call because a NextResponse is single-use, from a
 * single frozen literal so the branches cannot drift apart one edit at a time.
 */
const ACCEPTED = Object.freeze({ ok: true });
const accepted = () => NextResponse.json(ACCEPTED);

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const ip = clientIp(req.headers);
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `blogsub:${ip}`, { limit: 20 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: t('subscribe.tooManyRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  const parsed = await readBoundedRequestJson(req, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.reason === 'too_large' ? 'Request body too large.' : 'Bad payload' },
      { status: parsed.reason === 'too_large' ? 413 : 400 },
    );
  }
  const body = (parsed.value && typeof parsed.value === 'object' ? parsed.value : {}) as {
    email?: unknown; source?: unknown; visitorId?: unknown; website?: unknown;
  };

  // Honeypot: real users never see (or fill) the "website" field. The same
  // answer as everything else, so a bot learns neither that it was caught nor
  // which field caught it.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return accepted();
  }

  const email = normalizeEmail(body.email);
  if (!email) return NextResponse.json({ error: t('subscribe.enterAValidEmailAddress') }, { status: 400 });

  const source = normalizeSource(body.source);
  const visitorId = normalizeVisitorId(body.visitorId);

  // Per-ADDRESS throttle, on top of the per-IP one above. The notice below is
  // mail we send to an address the caller only claims to own, so repeating the
  // submission must not repeat the mail; keying it on the address rather than
  // the IP means rotating IPs does not lift it.
  //
  // It decides ONLY whether the notice is sent. It must never reach the
  // response — a 429 that depended on how often an address had been submitted
  // would hand back the oracle through the back door, since another visitor's
  // subscribe would be the thing that tripped it. Applied before the lookup and
  // keyed on the submitted string, so it behaves identically for an address we
  // know and one we have never seen.
  const mailable = await enforceRequestRateLimit(
    supabase, `blogsub:addr:${email}`, { limit: 3, windowMs: 3_600_000 },
  );

  const { data: existing, error: lookupError } = await supabase
    .from('blog_subscribers')
    .select('id, status, unsubscribe_token')
    .eq('email', email)
    .maybeSingle();

  // A refused read is not "no such subscriber". Discarding this error sent the
  // handler down the insert path, where the unique violation reads as success —
  // so a subscriber who had opted out and asked to come back would be told yes
  // over a row still marked unsubscribed. Same defect the sibling unsubscribe
  // route was fixed for in tests/public-route-write-honesty.test.ts.
  if (lookupError) {
    console.error('[blog-subscribe] subscriber lookup failed', lookupError);
    return NextResponse.json({ error: t('subscribe.couldNotSubscribeRightNow') }, { status: 500 });
  }

  let outcome: SubscribeOutcome;
  let token: string | null;

  if (existing) {
    const wasActive = existing.status === 'active';
    outcome = wasActive ? 'already' : 'reactivated';
    token = existing.unsubscribe_token;
    // Unconditional on purpose: both states issue exactly one UPDATE, so the
    // request does the same work whichever one it found. For a row that is
    // already active this re-asserts the status it already had and leaves
    // attribution alone — re-writing `source` there would let an anonymous
    // caller rewrite a subscriber's attribution by guessing their address.
    const patch = wasActive
      ? { status: 'active' }
      : { status: 'active', source, unsubscribed_at: null, ...(visitorId ? { visitor_id: visitorId } : {}) };
    const { error } = await supabase
      .from('blog_subscribers')
      .update(patch)
      .eq('id', existing.id);
    if (error) {
      console.error('[blog-subscribe] re-activation write failed', { subscriberId: existing.id, error });
      return NextResponse.json({ error: t('subscribe.couldNotSubscribeRightNow') }, { status: 500 });
    }
  } else {
    const { data: inserted, error } = await supabase
      .from('blog_subscribers')
      .insert({ email, source, visitor_id: visitorId })
      .select('unsubscribe_token')
      .single();
    if (error) {
      // A concurrent insert racing us is fine — the subscriber exists either
      // way, and the request that won the race sends the notice.
      if (error.code === '23505') return accepted();
      console.error('[blog-subscribe] subscriber insert failed', error);
      return NextResponse.json({ error: t('subscribe.couldNotSubscribeRightNow') }, { status: 500 });
    }
    outcome = 'created';
    token = inserted?.unsubscribe_token ?? null;
  }

  // Awaited, not fired and forgotten: on a serverless runtime the response
  // freezes the invocation, and a notice that races the response is a notice
  // that sometimes never leaves. It cannot change what is returned.
  if (mailable.ok && token) await sendSubscribeNotice(email, outcome, token);

  return accepted();
}
