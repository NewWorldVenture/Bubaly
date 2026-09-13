import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// One-click blog unsubscribe — the link future digest emails will carry
// (?token=<unsubscribe_token>). Token-keyed so it works with no session, and
// idempotent: unsubscribing twice is still unsubscribed. Redirects to the blog
// with a human-readable confirmation instead of returning bare JSON.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  // for, and `blog_subscribers` was not one of them.
  const supabase = createServiceClient();
  const { data, error: lookupError } = await supabase
    .from('blog_subscribers')
    .select('id, status')
    .eq('unsubscribe_token', token)
    .maybeSingle();

  if (lookupError) {
    console.error('[blog-unsubscribe] subscriber lookup failed', lookupError);
    home.searchParams.set('unsubscribed', 'error');
    return NextResponse.redirect(home);
  }

  if (data && data.status !== 'unsubscribed') {
    const { error: updateError } = await supabase
      .from('blog_subscribers')
      .update({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() })
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
