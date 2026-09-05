// middleware.ts — refreshes the Supabase session and guards protected routes.
import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

const PUBLIC = ['/', '/features', '/how-it-works', '/pricing', '/security',
  '/ai', '/mobile', '/faq', '/blog', '/contact', '/login', '/signup', '/auth',
  '/join', '/offline',
  // Legal pages — public for everyone, including signed-out visitors.
  '/terms', '/privacy', '/cookies', '/acceptable-use',
  // Public survey response pages (NPS/CSAT/CES) — respondents may be anonymous.
  '/s',
  // Public reviews wall + submission page — no login required.
  '/reviews',
  // Public Family Wallet gift pages — relatives gift via an unguessable token.
  '/gift',
  // Public exit-intent offer resolve + metric beacon (anonymous visitors).
  '/api/exit-intent',
  // Public contact, blog, and marketing telemetry endpoints. These routes
  // apply their own bounded-body, rate-limit, and consent/token controls.
  '/api/contact',
  '/api/blog',
  '/api/ab',
  '/api/mkt',
  '/api/services/descriptions',
  // Public gift-link AI assistant; the gift token and durable IP limiter are
  // the authorization boundary for this narrowly scoped read path.
  '/api/ai/gift',
  // Public marketing landing pages + their metric beacon.
  '/lp',
  '/api/lp/track',
  // Public marketing forms (lead capture) + their submit endpoint.
  '/f',
  '/api/forms',
  // Public iCalendar feeds: subscribed to by Apple Calendar / Outlook / Alexa
  // with no login — the unguessable feed token IS the authorization.
  '/api/sync/feeds',
  // Liveness/readiness probe for uptime monitors + LB health checks. Must be
  // reachable without a session (a monitor cannot authenticate); it is read-only
  // and returns only booleans/latency/missing-var names — never a secret.
  '/api/health',
  // Scheduled jobs, internal callbacks, and provider webhooks authenticate
  // themselves with a shared secret or provider signature in their route.
  '/api/cron',
  '/api/concierge-calls',
  '/api/guardian',
  '/api/email/welcome',
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
  // Static, always-public files bypass middleware entirely — they carry no
  // session and must stay reachable signed-out. robots.txt and sitemap.xml are
  // fetched by crawlers; manifest.webmanifest and sw.js by PWA install and
  // service-worker registration. Routing any of them through the auth guard
  // 307s them to /login, which silently breaks indexing, install, offline mode,
  // and web push — with no error anywhere to notice.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots\\.txt|sitemap\\.xml|manifest\\.webmanifest|sw\\.js|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico)$).*)',
  ],
};
