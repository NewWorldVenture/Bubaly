// middleware.ts — refreshes the Supabase session and guards protected routes.
import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createSessionRefreshFetch } from '@/shared/auth/refresh-fetch';
import { safeInternalRedirect } from '@/lib/auth/redirect';
import { PROTECTED, PUBLIC, matchesPrefix } from '@/lib/auth/route-access';
import {
  durableCookieOptions, hasAuthCookies, isRetryableAuthError, isSecureRequest,
  shouldForwardAuthCode,
} from '@/lib/auth/session';


// Provider callbacks authenticate inside their handlers. Keep this list exact:
// future Contact Center settings or data endpoints still require a user session.
const PUBLIC_CONTACT_CALLBACKS = new Set([
  '/api/contact-center/email',
  '/api/contact-center/sms',
  '/api/contact-center/sms/status',
  '/api/contact-center/voice',
  '/api/contact-center/voice/transcription',
]);

// The assistant bridge's two entry points.
//
// Found the same way the Contact Center webhooks above were: they were not
// here, so middleware answered a speaker's POST with a 307 to the HTML login
// page and the route — with its token check and its Amazon signature
// verification — never ran at all. Every utterance from every Alexa, Siri
// Shortcut and Home Assistant failed, and the failure looked like a device or
// a skill problem rather than a routing one. Nothing in the feature's own
// tests could see it, because they all start inside the handler.
//
// Safe to be public for the same reason as that group: each authenticates
// ITSELF. /api/assistant requires a `bub_asst_…` capability token and answers
// 401 without one; /api/assistant/alexa additionally proves the request came
// from Amazon — signature, certificate chain to a trusted root, and a 150
// second replay window — and answers 403 when it cannot.
//
// An EXACT set and POST only, not a '/api/assistant' prefix. A prefix would
// also open any settings or management endpoint added under it later, and
// those belong behind a session. Same shape as the Contact Center callbacks
// below it in spirit: name the paths, do not open a namespace.
const PUBLIC_ASSISTANT_CALLBACKS = new Set([
  '/api/assistant',
  '/api/assistant/alexa',
]);

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // This exact public path exposes only the artifact's revision. Do not refresh
  // sessions or interpret OAuth query parameters for this read-only response.
  if (path === '/api/build-info') return NextResponse.next({ request: req });
  // Logout replies must never carry stale authentication cookie mutations.
  // The browser performs its own guarded local deletion after explicit intent.
  if (path === '/auth/signout' || path === '/auth/signout/complete') return NextResponse.next({ request: req });
  // Child credentials are verified by this public action, then the browser
  // adopts its receipt conditionally. A delayed action response must not carry
  // an unrelated ambient session refresh that bypasses that ownership check.
  if (path === '/kid-login' && req.method === 'POST' && req.headers.has('next-action')) return NextResponse.next({ request: req });
  const recoveryPage = path === '/auth/recovery'
    || (path === '/login' && req.nextUrl.searchParams.get('reset') === '1');

  // A Supabase OAuth code that landed on the wrong path gets forwarded to
  // /auth/callback — but ONLY when it is ours to exchange. `code` is the
  // standard OAuth parameter, so this rescue used to capture the provider
  // callbacks under /api/ (Google Calendar, the sync providers) and hand their
  // authorization codes to exchangeCodeForSession, which answered /login: a
  // signed-in user logged out for connecting their calendar. See
  // shouldForwardAuthCode.
  if (shouldForwardAuthCode({
    path,
    hasCode: req.nextUrl.searchParams.has('code'),
    cookieNames: req.cookies.getAll().map((c) => c.name),
  })) {
    const url = req.nextUrl.clone();
    url.pathname = '/auth/callback';
    if (recoveryPage) url.searchParams.set('next', '/auth/recovery');
    return NextResponse.redirect(url);
  }

  // Recovery verifies the exact candidate token in its own action/callback.
  // Ambient refresh here would attach session A cookies to a delayed response
  // and could overwrite a newer browser session B before UI guards can act.
  if (recoveryPage || (path === '/auth/callback' && req.nextUrl.searchParams.get('next') === '/auth/recovery')) {
    return NextResponse.next({ request: req });
  }

  const isPublic = PUBLIC_CONTACT_CALLBACKS.has(path)
    || (req.method === 'POST' && PUBLIC_ASSISTANT_CALLBACKS.has(path))
    || matchesPrefix(path, PUBLIC);

  // Whether this path requires a session AT ALL. Public wins first, so a
  // public path nested under a protected prefix — /api/webhooks under /api —
  // stays reachable.
  //
  // A path that is neither is a path with no route: it falls through to the
  // router, which renders app/not-found.tsx with a 404. It used to be sent to
  // /login, which put a sign-in form in front of a typo and showed crawlers a
  // redirect to an irrelevant page — a soft 404 — for every bad URL on the
  // internet that happens to point here.
  const isProtected = !isPublic && matchesPrefix(path, PROTECTED);
  // The AI edge (/api/ai, /api/ai/requests, /api/ai/runs/*) is called by the
  // mobile app with `Authorization: Bearer <supabase jwt>` and no cookie. Those
  // handlers verify the token themselves (`authenticateAI` /
  // `getBearerUserContext`) and answer 401 when it is bad; every other route
  // under /api/ai calls `requireUserContext`, which fails closed without a
  // session. So a bearer request there must reach its handler: a 307 to the
  // HTML login page is not an answer a JSON client can act on. Only a
  // well-formed bearer header opts out, and only under /api/ai.
  const bearerApi = (path === '/api/ai' || path.startsWith('/api/ai/'))
    && /^Bearer\s+\S+$/i.test((req.headers.get('authorization') ?? '').trim());
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    if (isPublic || bearerApi || !isProtected) return NextResponse.next({ request: req });
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirect', safeInternalRedirect(`${path}${req.nextUrl.search}`, path));
    return NextResponse.redirect(url);
  }

  // Refreshed auth cookies have to reach TWO places, or a signed-in user gets
  // signed out. `res` carries them to the browser. `req.cookies` carries them
  // to the Server Components rendering this same request: without that they
  // read the original jar, whose refresh token this refresh just consumed, and
  // spend it a second time — which Supabase's reuse detection treats as a
  // stolen token and answers by revoking the whole session family. So write
  // both, and rebuild `res` from the updated request.
  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      global: { fetch: createSessionRefreshFetch(supabaseUrl) },
      cookieOptions: durableCookieOptions(isSecureRequest({
        forwardedProto: req.headers.get('x-forwarded-proto'),
        url: req.nextUrl.origin,
      })),
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (toSet: { name: string; value: string; options: CookieOptions }[], headers: Record<string, string> = {}) => {
          toSet.forEach(({ name, value }) => req.cookies.set(name, value));
          res = NextResponse.next({ request: req });
          toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
          Object.entries(headers).forEach(([name, value]) => res.headers.set(name, value));
        },
      },
    },
  );
  const { data: { user }, error } = await supabase.auth.getUser();

  // A signed-in user stays signed in until they sign out — including through a
  // Supabase outage. `getUser()` reports an unreachable auth server with the
  // same empty `user` a signed-out visitor gets, so redirecting on `!user`
  // alone turns a network blip into a logout screen for someone whose session
  // is perfectly valid. When the request still carries auth cookies and the
  // failure was transient, let it through: the page's own `requireUserContext`
  // guard re-checks, and the next request refreshes normally.
  const sessionMayStillBeValid = isRetryableAuthError(error) && hasAuthCookies(
    req.cookies.getAll().map((c) => c.name),
  );
  if (!user && isProtected && !bearerApi) {
    if (sessionMayStillBeValid) {
      console.warn('[middleware] auth lookup failed transiently; keeping the session', error);
      return res;
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('redirect', safeInternalRedirect(`${path}${req.nextUrl.search}`, path));
    // Carry any cookie the refresh just wrote onto the redirect too — a brand
    // new response would drop them and strand the browser on a stale session.
    return withCookies(NextResponse.redirect(url), res);
  }
  return res;
}

/** Copy every cookie `source` set onto `target` (redirects start out empty). */
function withCookies(target: NextResponse, source: NextResponse): NextResponse {
  source.cookies.getAll().forEach((cookie) => target.cookies.set(cookie));
  for (const name of ['cache-control', 'expires', 'pragma']) {
    const value = source.headers.get(name);
    if (value) target.headers.set(name, value);
  }
  return target;
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
