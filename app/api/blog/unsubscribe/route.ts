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

  const supabase = createServiceClient();
  const { data } = await supabase
    .from('blog_subscribers')
    .select('id, status')
    .eq('unsubscribe_token', token)
    .maybeSingle();

  if (data && data.status !== 'unsubscribed') {
    await supabase
      .from('blog_subscribers')
      .update({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() })
      .eq('id', data.id);
  }

  home.searchParams.set('unsubscribed', data ? '1' : 'invalid');
  return NextResponse.redirect(home);
}
