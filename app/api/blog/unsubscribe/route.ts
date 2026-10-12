import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { wroteNoRows } from '@/lib/supabase/errors';

export const runtime = 'nodejs';

// One-click blog unsubscribe — the link future digest emails will carry
// (?token=<unsubscribe_token>). Token-keyed so it works with no session, and
// idempotent: unsubscribing twice is still unsubscribed. Redirects to the blog
// with a human-readable confirmation instead of returning bare JSON.
//
// EVERY VALID CLICK IS WRITTEN, AN ADDRESS ALREADY OPTED OUT INCLUDED
// (AUD-1028-M1-REPEAT). /api/blog/subscribe reverses an opt-out only after the
// address has been mailed that it happened, so it reads the row, waits on the
// mail provider, and then writes guarded on the status and opt-out time it
// read (app/api/blog/subscribe/route.ts). A click on the link in that very
// notice lands DURING the wait, on a row that still says `unsubscribed`; this
// route used to leave such a row untouched, so both guarded columns still
// matched and the reactivation the owner had just refused went through. Each
// click now re-stamps the opt-out with a time later than the one on the row,
// which no reactivation read before it can match.
//
// AND A CLICK ONLY EVER MOVES THE OPT-OUT FORWARD (AUD-1028-M1-ABA). The
// re-stamp was computed from an unlocked read and written over whatever the
// row said by then. Two clicks overlapping a reactivation could put back a
// stamp the reactivation had read: with the clock at T, click A reads T and
// pauses; click B writes T+1; a reactivation reads T+1 and waits on its
// notice; click C writes T+2; A lands and writes T+1 over it — and the
// reactivation's guard matched again and put the address back on the list
// despite C. So the write is a compare-and-set on the status and opt-out time
// this click read, like the reactivation's own: a click another write has
// overtaken writes nothing, re-reads the row, and stamps again later than
// everything it has seen. A click that is overtaken on every attempt says so
// (`error`) rather than claiming an opt-out it could not write.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * How many times one click writes: the first try, and a re-read and retry for
 * each time a newer write overtook it. Losing once takes another click (or a
 * reactivation) landing in the few milliseconds between a read and a write;
 * losing every time is contention, answered honestly rather than spun on.
 */
const WRITE_ATTEMPTS = 3;

type Observed = { id: string; status: string; unsubscribed_at: string | null };

/**
 * The opt-out time this click writes: now, and in any case later than every
 * opt-out time this click has seen on the row (`latestSeen`, epoch ms), so it
 * differs from any stamp this click saw a reactivation in flight read, even
 * within the same millisecond or behind a clock that stepped back. A click that
 * finds the row already reactivated has seen no stamp: its `now` is only later
 * than an opt-out from before that reactivation while the clock moves forward,
 * and a reactivation still waiting from before it could match a repeat of that
 * exact millisecond. Closing that needs the reactivation to keep its opt-out
 * time (a generation), which the subscribe route does not.
 */
function optOutStamp(latestSeen: number): string {
  const now = Date.now();
  return new Date(latestSeen >= now ? latestSeen + 1 : now).toISOString();
}

export async function GET(req: NextRequest) {
  const token = (req.nextUrl.searchParams.get('token') ?? '').trim();
  const home = new URL('/blog', req.nextUrl.origin);
  if (!UUID_RE.test(token)) {
    home.searchParams.set('unsubscribed', 'invalid');
    return NextResponse.redirect(home);
  }

  // Both the read and the write are checked, because this page TELLS the reader
  // what happened and only one of the three answers it can give was ever true.
  //
  // A PostgREST call resolves with { data, error }. The lookup's error was
  // discarded, so a refused read produced `data: null` — which this route could
  // not tell apart from "no such token" and reported as `invalid`: a real
  // subscriber, holding a real link, told their link was wrong. And the update's
  // error was discarded too, so a refused write still redirected to
  // `unsubscribed=1` — "You've been unsubscribed from blog updates" over a row
  // that still says subscribed, and the next digest goes out to them.
  //
  // That is the same defect as the marketing unsubscribe (C-07). It survived
  // that pass because the guard there watches four tables it could name readers
  // for, and `blog_subscribers` was not one of them. Consent is the one thing
  // this endpoint exists to record, and a page the recipient reached from an
  // email they asked to stop is the last place to be confidently wrong.
  const supabase = createServiceClient();
  const { data, error: lookupError } = await supabase
    .from('blog_subscribers')
    .select('id, status, unsubscribed_at')
    .eq('unsubscribe_token', token)
    .maybeSingle();

  if (lookupError) {
    console.error('[blog-unsubscribe] subscriber lookup failed', lookupError);
    home.searchParams.set('unsubscribed', 'error');
    return NextResponse.redirect(home);
  }

  if (!data) {
    home.searchParams.set('unsubscribed', 'invalid');
    return NextResponse.redirect(home);
  }

  // Written whatever status was read, so a reactivation waiting on its notice
  // cannot outlast this click (see the top of this file), and written only
  // over the row as this click read it, so a stale click cannot put back an
  // opt-out time a newer one replaced. Service role, so RLS is never why the
  // write matches nothing: either the row moved since the read — another
  // click, or a reactivation — and is read again, or it was deleted since,
  // and a person with no row is not on the list — which is what they asked for.
  let observed: Observed = data;
  let latestSeen = Number.NEGATIVE_INFINITY;
  for (let attempt = 1; ; attempt += 1) {
    const seenStamp = observed.unsubscribed_at ?? null;
    const seenAt = seenStamp === null ? Number.NaN : Date.parse(seenStamp);
    if (Number.isFinite(seenAt)) latestSeen = Math.max(latestSeen, seenAt);
    const advance = supabase
      .from('blog_subscribers')
      .update({ status: 'unsubscribed', unsubscribed_at: optOutStamp(latestSeen) })
      .eq('id', observed.id)
      .eq('status', observed.status);
    const { data: advanced, error: updateError } = await (seenStamp === null
      ? advance.is('unsubscribed_at', null)
      : advance.eq('unsubscribed_at', seenStamp)
    ).select('id');
    if (updateError) {
      console.error('[blog-unsubscribe] unsubscribe write failed', { subscriberId: observed.id, error: updateError });
      home.searchParams.set('unsubscribed', 'error');
      return NextResponse.redirect(home);
    }
    if (!wroteNoRows(advanced)) break;

    if (attempt >= WRITE_ATTEMPTS) {
      console.error('[blog-unsubscribe] unsubscribe write was overtaken on every attempt', { subscriberId: observed.id, attempts: attempt });
      home.searchParams.set('unsubscribed', 'error');
      return NextResponse.redirect(home);
    }
    // A refused re-read is not "the row is gone": the click is unrecorded.
    const { data: fresh, error: rereadError } = await supabase
      .from('blog_subscribers')
      .select('id, status, unsubscribed_at')
      .eq('id', observed.id)
      .maybeSingle();
    if (rereadError) {
      console.error('[blog-unsubscribe] subscriber re-read failed', { subscriberId: observed.id, error: rereadError });
      home.searchParams.set('unsubscribed', 'error');
      return NextResponse.redirect(home);
    }
    if (!fresh) break;
    observed = fresh;
  }

  home.searchParams.set('unsubscribed', '1');
  return NextResponse.redirect(home);
}
