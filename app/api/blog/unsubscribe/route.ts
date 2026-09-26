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

  // Both results are read. Discarding either turns a database failure into a
  // confident lie on a page the recipient reached from an email they asked to
  // stop: a refused SELECT rendered "that link doesn't look right" at a real
  // subscriber holding a real link, and a refused UPDATE rendered "you've been
  // unsubscribed" over a row that still said subscribed — so the mail kept
  // coming, and they had been told it would not. Consent is the one thing this
  // endpoint exists to record.
  const supabase = createServiceClient();
  const { data, error: readError } = await supabase
    .from('blog_subscribers')
    .select('id, status')
    .eq('unsubscribe_token', token)
    .maybeSingle();

  if (readError) {
    console.error('[blog] unsubscribe lookup failed', readError);
    home.searchParams.set('unsubscribed', 'error');
    return NextResponse.redirect(home);
  }

  if (data && data.status !== 'unsubscribed') {
    // Deliberately NOT confirmed. This runs on the service role, so RLS cannot be
    // what makes it match nothing: zero rows means the row was deleted since the
    // read, and a person with no row is not on the list — which is what they
    // asked for. Confirming it would show "error" on an unsubscribe that took.
    // Audit C1-S9-62.
    const { error: writeError } = await supabase
      .from('blog_subscribers')
      .update({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() })
      .eq('id', data.id);
    if (writeError) {
      console.error('[blog] unsubscribe write failed', writeError);
      home.searchParams.set('unsubscribed', 'error');
      return NextResponse.redirect(home);
    }
  }

  home.searchParams.set('unsubscribed', data ? '1' : 'invalid');
  return NextResponse.redirect(home);
}
