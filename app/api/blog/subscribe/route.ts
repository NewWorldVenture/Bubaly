import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { wroteNoRows } from '@/lib/supabase/errors';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { normalizeEmail, normalizeSource, normalizeVisitorId } from '@/lib/blog/engagement';
import { canonicalMailbox } from '@/lib/server/canonical-mailbox';
import { sendSubscribeNotice, type SubscribeOutcome } from '@/lib/blog/subscribe-notice';
import { carriedVisitorId, namesAnotherVisitor } from '@/lib/marketing/visitor-cookie';

export const runtime = 'nodejs';

// Public blog subscribe endpoint. An explicit email opt-in from the blog's
// subscribe forms → blog_subscribers (service-role only; RLS denies clients).
// Bot defenses: honeypot field (silently accepted, never written), IP rate
// limit, per-address mail throttle, bounded body, strict email normalization.
// Re-subscribing after an unsubscribe re-activates — a fresh explicit opt-in is
// new consent — but only once the address has been mailed that it happened; a
// submission whose notice is throttled, fails, is skipped or throws leaves the
// opt-out standing, and so does one that loses a race with an unsubscribe.
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
// sentence whichever write failed. A write that lost a race is not a failure:
// two simultaneous submissions of one address get the same pair of answers
// whether it is on the list, opted out or new.
//
// Timing is kept boring rather than left to chance: every accepted address
// takes the same two rate-limit round trips, one lookup, exactly ONE write, and
// one mail dispatch, whatever state it was in (a reactivation dispatches before
// its write, because the write depends on it; a write that a concurrent change
// left matching no row adds one read by id and mails nothing after it). The
// honeypot is the one branch that answers without doing that work, and
// equalising it would mean writing bot rows or sleeping — the body it returns
// is identical, which is what the caller can actually read.
//
// WHICH VISITOR THE ADDRESS IS ATTRIBUTED TO COMES FROM THE COOKIE (SEC-008).
//
// `visitor_id` used to be read from the body, so a request could stitch an
// email to any visitor id it chose, on insert and on re-activation. It is now
// the `bubaly_vid` cookie the request carries, through the same helpers as
// /api/mkt/consent (SEC-006) and /api/mkt/track (SEC-007), with the same stated
// limit: the cookie is the same bearer bytes, so this stops a caller naming a
// visitor other than the one its browser is, not a holder of an id presenting
// it. No cookie means no attribution, which is what the column has always
// allowed. A body that still names an id (a cached older form) is accepted only
// when it IS the cookie; any other is refused, 403, before the honeypot and
// before the lookup — it is a property of the request alone, so the refusal is
// the same for every address and says nothing about any of them.

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

  const carried = carriedVisitorId(req);
  if (namesAnotherVisitor(body.visitorId, carried)) {
    return NextResponse.json({ error: t('subscribe.notThisVisitor') }, { status: 403 });
  }

  // Honeypot: real users never see (or fill) the "website" field. The same
  // answer as everything else, so a bot learns neither that it was caught nor
  // which field caught it.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return accepted();
  }

  const email = normalizeEmail(body.email);
  if (!email) return NextResponse.json({ error: t('subscribe.enterAValidEmailAddress') }, { status: 400 });

  const source = normalizeSource(body.source);
  const visitorId = normalizeVisitorId(carried);

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
  //
  // Keyed on the canonical INBOX, not the string as typed. `victim+1@gmail.com`,
  // `victim+2@gmail.com` and `v.ictim@gmail.com` are one inbox, and as three
  // keys they were three allowances — each a new row and a new notice, so one
  // IP walked the limit off one `+tag` at a time. The canonical form is still a
  // function of the submitted string alone, so the anti-oracle property above
  // holds; the row keeps the address exactly as it was typed.
  const mailable = await enforceRequestRateLimit(
    supabase, `blogsub:addr:${canonicalMailbox(email)}`, { limit: 3, windowMs: 3_600_000 },
  );

  const { data: existing, error: lookupError } = await supabase
    .from('blog_subscribers')
    .select('id, status, unsubscribe_token, unsubscribed_at')
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
  // Whether this request has already dispatched its one notice.
  let noticed = false;

  if (existing) {
    const wasActive = existing.status === 'active';
    token = existing.unsubscribe_token;
    outcome = wasActive ? 'already' : 'reactivated';
    // An opt-out is reversed only once the address HAS BEEN told it was.
    // Nobody has to own the address to submit it, so the notice is the owner's
    // one chance to undo it. Reactivating regardless of the notice let a caller
    // spend the address's notices, wait for the owner to unsubscribe, and
    // silently put them back on the list; reactivating BEFORE the notice and
    // then sending it did the same whenever the send failed, was skipped for
    // want of a provider, or threw — sendSubscribeNotice swallows all three. So
    // the notice goes first, and only one the provider accepted reactivates.
    // A throttled, failed or skipped notice leaves the row as it is.
    let reactivate = false;
    if (!wasActive && mailable.ok && token) {
      reactivate = await sendSubscribeNotice(email, 'reactivated', token);
      noticed = true;
    }
    // Exactly one UPDATE in every state, so the request does the same work
    // whichever one it found. For a row that is not being reactivated this
    // re-asserts the status it already had and leaves attribution alone —
    // re-writing `source` there would let an anonymous caller rewrite a
    // subscriber's attribution by guessing their address.
    const patch = reactivate
      ? { status: 'active', source, unsubscribed_at: null, ...(visitorId ? { visitor_id: visitorId } : {}) }
      : { status: existing.status };
    // GUARDED ON WHAT WAS READ. Unguarded, this wrote the status of a lookup
    // that may be stale by now: the owner unsubscribing between the lookup and
    // this write (from any notice — the token never changes) was overwritten
    // with `active`, by the re-assert as much as by a reactivation. The write
    // lands only while the row still has the status and opt-out time this
    // request saw; anything else matches no row, writes nothing, and the newer
    // state stands (below). A click on the unsubscribe link moves the opt-out
    // time even on a row that already says `unsubscribed`
    // (app/api/blog/unsubscribe/route.ts), so the owner refusing this very
    // notice while the provider is still answering is a newer state too
    // (AUD-1028-M1-REPEAT).
    const guarded = supabase
      .from('blog_subscribers')
      .update(patch)
      .eq('id', existing.id)
      .eq('status', existing.status);
    const { data: patched, error } = await (existing.unsubscribed_at === null
      ? guarded.is('unsubscribed_at', null)
      : guarded.eq('unsubscribed_at', existing.unsubscribed_at)
    ).select('id');
    if (error) {
      console.error('[blog-subscribe] re-activation write failed', { subscriberId: existing.id, error });
      return NextResponse.json({ error: t('subscribe.couldNotSubscribeRightNow') }, { status: 500 });
    }
    // Service role, so zero rows means the row moved between the lookup and
    // this write: its status or opt-out changed, or it was deleted.
    //
    // A ROW THAT MOVED IS STILL AN ACCEPTED SUBMISSION, AND GETS accepted().
    // This used to answer 500 for it, and that was the middle answer again,
    // readable by anyone: two simultaneous submissions of an address that had
    // opted out both read the opt-out, both wait out a notice, the first
    // reactivates and the second's guard then matches nothing — 500. An active
    // row's re-assert changes neither guarded column, so its twin still
    // matches, and a never-seen address's twin takes the 23505 branch; so the
    // pair answered [200, 200], [200, 200] and [200, 500], and the 500 named
    // the opt-out. Nothing is written here and no further notice is sent —
    // "already on the list" would be untrue of a row the owner just left — so
    // whatever the row now says (the owner's newer opt-out, or the twin's
    // reactivation) stands, and the caller gets the one answer.
    //
    // A row that is GONE keeps the 500, so the retry finds no row and takes
    // the insert path (Audit C1-S9-62). Telling the two apart costs one read
    // by primary key, on this race-only path. It says nothing a caller can
    // steer: no public route deletes a subscriber (unsubscribing is a status),
    // so only an operator's erasure can land between the two. A refused
    // re-read is not "the row is there": it is a failed read, answered with
    // the same sentence as the failed lookup above.
    if (wroteNoRows(patched)) {
      const { data: still, error: recheckError } = await supabase
        .from('blog_subscribers')
        .select('id')
        .eq('id', existing.id)
        .maybeSingle();
      if (recheckError || !still) {
        console.error('[blog-subscribe] subscriber write matched no row and the row could not be found', {
          subscriberId: existing.id, error: recheckError,
        });
        return NextResponse.json({ error: t('subscribe.couldNotSubscribeRightNow') }, { status: 500 });
      }
      return accepted();
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
  // that sometimes never leaves. It cannot change what is returned. A
  // reactivation's notice was sent above, before the write it permits.
  if (!noticed && mailable.ok && token) await sendSubscribeNotice(email, outcome, token);

  return accepted();
}
