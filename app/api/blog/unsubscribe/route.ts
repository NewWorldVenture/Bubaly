import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The opt-out time this click writes: now, and in any case later than the one
 * already on the row, so it differs from anything a reactivation in flight
 * read — even within the same millisecond, or behind a clock that stepped back.
 */
function optOutStamp(previous: string | null | undefined): string {
  const now = Date.now();
  const before = previous ? Date.parse(previous) : Number.NaN;
  return new Date(Number.isFinite(before) && before >= now ? before + 1 : now).toISOString();
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

  if (data) {
    // Written whatever status was read, so a reactivation waiting on its notice
    // cannot outlast this click (see the top of this file). Unguarded: a row a
    // reactivation moved to `active` since the read is opted out again.
    // Deliberately NOT confirmed. This runs on the service role, so RLS cannot be
    // what makes it match nothing: zero rows means the row was deleted since the
    // read, and a person with no row is not on the list — which is what they
    // asked for. Confirming it would show "error" on an unsubscribe that took.
    // Audit C1-S9-62.
    const { error: updateError } = await supabase
      .from('blog_subscribers')
      .update({ status: 'unsubscribed', unsubscribed_at: optOutStamp(data.unsubscribed_at) })
      .eq('id', data.id);
    if (updateError) {
      console.error('[blog-unsubscribe] unsubscribe write failed', { subscriberId: data.id, error: updateError });
      home.searchParams.set('unsubscribed', 'error');
      return NextResponse.redirect(home);
    }
  }

  home.searchParams.set('unsubscribed', data ? '1' : 'invalid');
  return NextResponse.redirect(home);
}
