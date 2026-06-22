// middleware.ts — refreshes the Supabase session and guards protected routes.
import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

const PUBLIC = ['/', '/features', '/how-it-works', '/pricing', '/security',
  '/ai', '/mobile', '/faq', '/blog', '/contact', '/login', '/signup', '/auth',
  '/join', '/offline',
  // Public survey response pages (NPS/CSAT/CES) — respondents may be anonymous.
  '/s',
  // Public reviews wall + submission page — no login required.
  '/reviews',
  // Public exit-intent offer resolve + metric beacon (anonymous visitors).
  '/api/exit-intent',
  // Public marketing landing pages + their metric beacon.
  '/lp',
  '/api/lp/track',
  // Public marketing forms (lead capture) + their submit endpoint.
  '/f',
  '/api/forms',
  // Public iCalendar feeds: subscribed to by Apple Calendar / Outlook / Alexa
  // with no login — the unguessable feed token IS the authorization.
  '/api/sync/feeds',
  // Provider webhooks (signature-verified) and the signed unsubscribe link must
  // be reachable without a session.
  '/api/webhooks',
  '/api/marketing/unsubscribe'];

export async function middleware(req: NextRequest) {
  const res = NextResponse.next({ request: req });
  const path = req.nextUrl.pathname;

  // If an OAuth code lands on the wrong path, forward it to /auth/callback
  const code = req.nextUrl.searchParams.get('code');
  if (code && path !== '/auth/callback') {
    const url = req.nextUrl.clone();
    url.pathname = '/auth/callback';
    return NextResponse.redirect(url);
  }

  const isPublic = PUBLIC.some((p) => path === p || path.startsWith(p + '/'));
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    if (isPublic) return res;
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirect', path);
    return NextResponse.redirect(url);
  }

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (toSet: { name: string; value: string; options: CookieOptions }[]) =>
          toSet.forEach(({ name, value, options }) =>
            res.cookies.set(name, value, options)),
      },
    },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirect', path);
    return NextResponse.redirect(url);
  }
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico)$).*)'],
};
