// A page written for signed-out visitors must be reachable without a session.
//
// middleware.ts is the outer authorization boundary: it answers a request
// before the page ever runs. So a public page that is not on its PUBLIC list
// is not "public with a redirect" — it does not exist for anyone without a
// cookie, and no amount of correct code inside the page can change that.
//
// This has now been the same defect five separate times: the Contact Center's
// four inbound webhooks, the assistant bridge, /opengraph-image and
// /twitter-image, eight of the eleven marketing page families, and /pay.
// Measured against production on 2026-09-13, before this fix:
//
//   GET /pay/emma     -> 307 /login?redirect=%2Fpay%2Femma
//   GET /pay/anything -> 307 /login?redirect=%2Fpay%2Fanything
//   GET /gift/token   -> 200
//
// The 200 on /gift is the tell: /pay/<handle> exists only to resolve a shared
// handle and forward to exactly that link, so a relative following a Pay-ID
// was stopped at a login wall one hop short of the page that would have worked.
//
// Rather than record a sixth instance later, this enumerates every page route
// outside app/(app) and requires each one to be either publicly reachable or
// named below as deliberately session-gated.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { MARKETING_PUBLIC_PREFIXES } from '@/lib/marketing/page-types';

// Routes outside app/(app) that genuinely require a session. Each needs a
// reason, because adding a name here is how a public page would get silently
// excused from the check below.
const DELIBERATELY_PRIVATE: Record<string, string> = {
  '/onboarding': 'Runs after sign-up and writes to the new account; there is no signed-out form of it.',
};

/**
 * Every page route under app/, with route groups removed from the URL but
 * remembered, so the signed-in shell under app/(app) can be told apart from
 * the pages that are supposed to serve anonymous visitors.
 */
function pageRoutes(dir = 'app', route = '', groups: string[] = []): { route: string; groups: string[] }[] {
  const found: { route: string; groups: string[] }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // (marketing) and friends group files without appearing in the URL.
      const isGroup = /^\(.*\)$/.test(entry.name);
      found.push(...pageRoutes(
        `${dir}/${entry.name}`,
        isGroup ? route : `${route}/${entry.name}`,
        isGroup ? [...groups, entry.name] : groups,
      ));
    } else if (entry.name === 'page.tsx') {
      found.push({ route: route === '' ? '/' : route, groups });
    }
  }
  return found;
}

const ALL = pageRoutes();
const OUTSIDE_APP_SHELL = ALL.filter((p) => !p.groups.includes('(app)')).map((p) => p.route).sort();

describe('every page meant for signed-out visitors is past the middleware', () => {
// The public allowlist moved to lib/auth/route-access.ts when middleware
// gained a PROTECTED list (so an unrouted path 404s instead of being sent
// to /login). Both files are read here: the routing LOGIC is still in
// middleware.ts, the allowlist entries are in the other.
  const middleware = readFileSync('middleware.ts', 'utf8') + readFileSync('lib/auth/route-access.ts', 'utf8');
  const literal = /const PUBLIC = \[([\s\S]*?)\];/.exec(middleware);

  // Comment lines first: the list documents which neighbours were left OFF it
  // ("Deliberately NOT '/display'"), and reading those as entries would have
  // this test report the signed-in kiosk as public.
  const entries = (literal?.[1] ?? '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const publicPrefixes = [
    ...Array.from(entries.matchAll(/'([^']+)'/g), (m) => m[1]),
    ...MARKETING_PUBLIC_PREFIXES,
  ];

  // The same test middleware applies: exact match, or a path segment under it.
  const isPublic = (path: string) =>
    publicPrefixes.some((p) => path === p || path.startsWith(p + '/'));

  it('can read the PUBLIC list it is checking', () => {
    expect(literal, 'the middleware PUBLIC list could not be parsed').not.toBeNull();
    expect(publicPrefixes).toContain('/login');
    expect(publicPrefixes).toContain('/pay');
    // Nothing the list only mentions in prose: /display appears in it solely
    // as the path the comment says must NOT be public.
    expect(literal![1], 'the prose case this parse has to survive').toContain("'/display'");
    expect(publicPrefixes, 'a path named in a comment is not an entry').not.toContain('/display');
  });

  it('found the routes it is supposed to be checking', () => {
    // A traversal that silently found nothing would pass every case below.
    expect(ALL.length).toBeGreaterThan(100);
    expect(OUTSIDE_APP_SHELL).toContain('/pay/[handle]');
    expect(OUTSIDE_APP_SHELL).toContain('/gift/[token]');
    expect(OUTSIDE_APP_SHELL).not.toContain('/dashboard');
  });

  it.each(OUTSIDE_APP_SHELL.filter((route) => !(route in DELIBERATELY_PRIVATE)))(
    '%s is reachable without a session',
    (route) => {
      expect(isPublic(route), `${route} answers 307 to /login before its page runs`).toBe(true);
    },
  );

  it('keeps the signed-in app behind the boundary', () => {
    // Widening PUBLIC is the fix for this defect class and also the way to
    // cause a far worse one, so pin the paths that must never be on it.
    for (const priv of ['/dashboard', '/admin', '/settings', '/display', '/onboarding']) {
      expect(isPublic(priv), `${priv} must require a session`).toBe(false);
    }
  });

  it('states why each exempted route needs a session', () => {
    for (const [route, reason] of Object.entries(DELIBERATELY_PRIVATE)) {
      expect(OUTSIDE_APP_SHELL, `${route} no longer exists; drop the exemption`).toContain(route);
      expect(reason.length, `${route} needs a real reason`).toBeGreaterThan(30);
    }
  });
});

// The other half of the same boundary: routes whose caller is a provider, a
// scheduler or a speaker, never a browser with a cookie. Each authenticates
// itself — a Twilio signature, an HMAC, a shared secret compared in constant
// time — and each is useless behind the session boundary, because middleware
// answers the provider's POST with a 307 to an HTML login page and the route's
// own authentication never runs. That is exactly how the Contact Center's four
// inbound webhooks came to be unreachable while looking correctly written.
describe('every self-authenticating API route is past the middleware', () => {
  const middleware = readFileSync('middleware.ts', 'utf8') + readFileSync('lib/auth/route-access.ts', 'utf8');
  const literal = /const PUBLIC = \[([\s\S]*?)\];/.exec(middleware);
  const entries = (literal?.[1] ?? '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const publicPrefixes = Array.from(entries.matchAll(/'([^']+)'/g), (m) => m[1]);
  // Some groups are exempted by EXACT path rather than by prefix — the
  // assistant bridge (POST only) and the Contact Center callbacks — because a
  // prefix would also open any settings or data endpoint added under it later.
  // Every such allowlist is read, not just the ones that existed when this was
  // written, so a third one does not silently fail every route it covers.
  const exactPublic = Array.from(
    middleware.matchAll(/const PUBLIC_\w+ = new Set\(\[([\s\S]*?)\]\)/g),
  ).flatMap((set) => Array.from(set[1].matchAll(/'([^']+)'/g), (m) => m[1]));
  const isPublic = (path: string) =>
    exactPublic.includes(path) || publicPrefixes.some((p) => path === p || path.startsWith(p + '/'));

  /** Every app/api/**\/route.ts, as the path it answers on. */
  function apiRoutes(dir = 'app/api', route = '/api'): { route: string; source: string }[] {
    const found: { route: string; source: string }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        found.push(...apiRoutes(`${dir}/${entry.name}`, `${route}/${entry.name}`));
      } else if (entry.name === 'route.ts') {
        found.push({ route, source: readFileSync(`${dir}/${entry.name}`, 'utf8') });
      }
    }
    return found;
  }

  // Verifies a provider signature, an HMAC, or a shared secret — or resolves an
  // unguessable bearer token that IS the authorization, the way the assistant
  // bridge and the calendar feeds do.
  // `verifyTwilioRequest` and `bearerMatches`/`secretsMatch` are the shared
  // gates the Twilio ingress and the shared-secret call sites moved into
  // (SEC-010, SEC-011). A route that reaches one of them authenticates
  // itself just as surely as one that read the header inline, and this list
  // has to follow the code or it quietly stops finding seven of the routes.
  const SELF_AUTHENTICATING = /x-twilio-signature|verifyTwilioRequest|verifySignature|createHmac|timingSafeEqual|bearerMatches|secretsMatch|CRON_SECRET|INBOUND_SECRET|svix|stripe\.webhooks|verifyAlexaRequest|resolveAssistantLink|resolveFeedToken/;
  // ...and does NOT also derive the caller from a Supabase session. A route
  // that does is session-gated on purpose: /api/google/calendar/callback
  // returns a signed-in user from Google and attaches the tokens to whoever
  // getUser() says they are, never to whatever `state` claims.
  const READS_SESSION = /requireUserContext|getUserContext|supabase\.auth\.getUser|createServer\(\)/;

  const all = apiRoutes();
  const providerCalled = all
    .filter((r) => SELF_AUTHENTICATING.test(r.source) && !READS_SESSION.test(r.source))
    .map((r) => r.route)
    .sort();

  it('found the routes it is supposed to be checking', () => {
    expect(all.length).toBeGreaterThan(100);
    expect(providerCalled.length).toBeGreaterThanOrEqual(18);
    // An allowlist parse that silently found nothing would fail every route it
    // covers and read as a middleware defect rather than a test one.
    expect(exactPublic.length, 'no exact-path allowlist parsed out of the middleware')
      .toBeGreaterThanOrEqual(2);
    expect(providerCalled, 'the Contact Center webhooks are the canonical case')
      .toContain('/api/contact-center/sms');
    expect(providerCalled, 'a session-derived OAuth callback is not provider-called')
      .not.toContain('/api/google/calendar/callback');
  });

  it.each(providerCalled)('%s is reachable by the caller it authenticates', (route) => {
    expect(isPublic(route), `${route} answers 307 to /login before its own auth runs`).toBe(true);
  });
});
