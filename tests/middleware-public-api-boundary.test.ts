import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const middleware = readFileSync('middleware.ts', 'utf8');

/**
 * What the middleware ACTUALLY answers, rather than what its source says.
 *
 * With no Supabase configuration the handler takes its early branch — public
 * and bearer requests pass, everything else is sent to /login — which is the
 * exact decision this file is about, reached without a network, a database or
 * a session. Every assertion below that matters is made this way: the
 * string checks further down can only prove a path is MENTIONED, and the
 * defect that prompted this was a path that was never mentioned at all.
 */
async function answerFor(path: string, method = 'GET'): Promise<{ status: number; location: string | null }> {
  const { middleware: handler } = await import('@/middleware');
  const res = await handler(new NextRequest(`https://www.bubaly.com${path}`, { method }));
  return { status: res.status, location: res.headers.get('location') };
}

const reaches = async (path: string, method = 'GET') => (await answerFor(path, method)).status === 200;
const sentToLogin = async (path: string, method = 'GET') => {
  const { status, location } = await answerFor(path, method);
  return status === 307 && (location ?? '').includes('/login');
};

describe('the assistant bridge is reachable by the devices that speak to it', () => {
  // FOUND IN REVIEW, not by any test the feature shipped with: /api/assistant
  // and /api/assistant/alexa were missing from the public list, so middleware
  // answered a speaker's POST with a 307 to the HTML login page and the route
  // never ran. Every utterance from every Alexa, Siri Shortcut and Home
  // Assistant failed — the token check and the Amazon signature verification
  // inside those handlers were unreachable code in production. Nothing caught
  // it because every other test for the feature starts INSIDE the handler.
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['/api/assistant', '/api/assistant/alexa'])('lets a POST to %s reach its own authorization', async (path) => {
    expect(await reaches(path, 'POST')).toBe(true);
  });

  it.each(['/api/assistant', '/api/assistant/alexa'])('still requires a session for a GET to %s', async (path) => {
    // Only the POST handler carries a token check. A GET has nothing to
    // authenticate itself with, so it has no business being public.
    expect(await sentToLogin(path, 'GET')).toBe(true);
  });

  it('does not open the namespace underneath it', async () => {
    // An exact set, not a '/api/assistant' prefix: settings or management
    // endpoints added under it later belong behind a session, and a prefix
    // would have opened them silently on the day they were created.
    for (const path of ['/api/assistant/settings', '/api/assistant/links', '/api/assistant/alexa/debug']) {
      expect(await sentToLogin(path, 'POST'), path).toBe(true);
    }
  });

  it('still sends an ordinary page to the login screen', async () => {
    // The control. Without it, a middleware that answered 200 for everything
    // would pass every assertion above.
    expect(await sentToLogin('/dashboard')).toBe(true);
    expect(await sentToLogin('/dashboard/assistants')).toBe(true);
  });

  it('keeps a family\'s downloaded episodes behind a session, as an answer and not as a grep', async () => {
    expect(await sentToLogin('/library/media/00000000-0000-4000-8000-000000000001')).toBe(true);
  });

  it('keeps the inbound provider webhooks reachable', async () => {
    for (const path of ['/api/contact-center/sms', '/api/guardian/inbound/sms', '/api/cron/library-feeds']) {
      expect(await reaches(path, 'POST'), path).toBe(true);
    }
  });
});

/**
 * The ways a route can prove who is calling WITHOUT a browser session.
 *
 * A route that carries one of these has a caller that is not a person: a
 * scheduler, a provider's webhook, a speaker in a kitchen. None of them has a
 * Supabase cookie, so every one of them is answered by middleware with a 307 to
 * the HTML login page unless the path is public — and the route, with all of
 * its own careful authentication, never runs at all.
 */
const SELF_AUTHENTICATING = [
  'hasCronAuthorization', 'hasInternalSecret',
  'validateTwilioSignature', 'x-twilio-signature',
  'readPresentedToken', 'looksLikeAssistantToken', 'verifyAlexaRequest',
  'CONTACT_CENTER_INBOUND_SECRET',
  'stripe-signature', 'svix-signature',
];

function selfAuthenticatingRoutes(dir = 'app/api', url = '/api'): { url: string; file: string; marker: string }[] {
  const out: { url: string; file: string; marker: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      // A dynamic segment still has to be routable; any concrete value will do.
      const segment = /^\[.+\]$/.test(entry.name) ? 'x' : entry.name;
      out.push(...selfAuthenticatingRoutes(next, `${url}/${segment}`));
    } else if (entry.name === 'route.ts') {
      const source = readFileSync(next, 'utf8');
      const marker = SELF_AUTHENTICATING.find((m) => source.includes(m));
      if (marker) out.push({ url, file: next, marker });
    }
  }
  return out;
}

describe('a route that authenticates itself can be reached to do it', () => {
  // THE GUARD FOR THE CLASS, not for the two paths that happened to be missing.
  //
  // This exact defect has now landed twice: once on the Family Contact Center's
  // four inbound webhooks, and once on the assistant bridge — where it made the
  // capability-token check and the whole Amazon signature verification
  // unreachable code in production. Both times every test passed, because every
  // test started inside the handler. Both times it presented as a provider or
  // device problem rather than a routing one.
  //
  // Derived from disk rather than from a list, so the next route to carry a
  // cron secret or a provider signature is covered on the day it is written.
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('finds the routes to check, rather than quietly finding none', () => {
    // A scan that matches nothing is indistinguishable from a clean result.
    expect(selfAuthenticatingRoutes().length).toBeGreaterThan(30);
  });

  it('answers every one of them without a session', async () => {
    const unreachable: string[] = [];
    for (const route of selfAuthenticatingRoutes()) {
      // Either verb: the scheduled jobs export GET, the webhooks and the
      // assistant export POST.
      if (await reaches(route.url, 'POST') || await reaches(route.url, 'GET')) continue;
      unreachable.push(`${route.url} (${route.file}, authenticates with ${route.marker})`);
    }
    expect(unreachable, 'these routes 307 to /login and can never run').toEqual([]);
  });
});

describe('middleware public API boundary', () => {
  it('keeps anonymous product surfaces reachable before route-level guards run', () => {
    for (const path of [
      '/api/contact', '/api/blog', '/api/ab', '/api/mkt',
      '/api/services/descriptions', '/api/ai/gift',
    ]) {
      expect(middleware, path).toContain(`'${path}'`);
    }
  });

  it('lets scheduled and signed provider callbacks reach their own authorization checks', () => {
    for (const path of [
      '/api/cron', '/api/concierge-calls', '/api/guardian', '/api/email/welcome',
      '/api/webhooks', '/api/contact-center',
    ]) {
      expect(middleware, path).toContain(`'${path}'`);
    }
  });

  it('keeps a family\'s downloaded episodes behind a session', () => {
    // /library/media/[itemId] streams podcast bytes from Bubaly's own origin so
    // that `cache.add()` — which answers to connect-src, not media-src — is
    // allowed to store them. It lives OUTSIDE /api on purpose, because sw.js
    // skips that prefix entirely and a media route there could never be cached.
    //
    // Being outside /api is exactly why this test exists: a future '/library'
    // entry in PUBLIC, added for some marketing page, would make every family's
    // episodes streamable by anyone holding an item id. The route also calls
    // requireUserContext() and reads through the user's own client, so RLS is
    // the real boundary — this is the outer one, and it should not be the first
    // thing to quietly go.
    const block = middleware.slice(middleware.indexOf('const PUBLIC = ['));
    const entries = [...block.slice(0, block.indexOf('];')).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const path = '/library/media/00000000-0000-4000-8000-000000000001';
    const matching = entries.filter((entry) => path === entry || path.startsWith(`${entry}/`));
    expect(matching, `PUBLIC must not cover ${path}`).toEqual([]);
  });

  it('keeps the Family Contact Center inbound webhooks reachable', () => {
    // Found in production: /api/contact-center was missing from PUBLIC, so a
    // POST to the inbound-email webhook answered 307 -> /login and the route
    // never ran. Inbound email, SMS, voice and transcription could not work
    // however the MX records and phone numbers were configured, and the failure
    // presented as a provider problem rather than a routing one.
    //
    // Safe to be public because each authenticates ITSELF, which is the whole
    // premise of this group: /email requires CONTACT_CENTER_INBOUND_SECRET and
    // is fail-closed in production, and the three Twilio routes verify
    // x-twilio-signature and answer 401.
    expect(middleware).toContain("'/api/contact-center'");
  });

  it('does not open the contact centre wider than its webhooks', () => {
    // The prefix covers /api/contact-center/*. The family-facing controls live
    // in server actions under /dashboard/contact-center, not here, so nothing
    // authenticated is exposed by this entry — but pin it, because adding a
    // session-backed route under this prefix later would silently make it
    // public.
    const routes = ['email', 'sms', 'voice', 'voice/transcription'];
    for (const route of routes) {
      expect(
        readFileSync(`app/api/contact-center/${route}/route.ts`, 'utf8'),
        `${route} must authenticate itself`,
      ).toMatch(/validateTwilioSignature|CONTACT_CENTER_INBOUND_SECRET/);
    }
  });

  it('keeps the health/readiness probe reachable without a session', () => {
    // Uptime monitors + load-balancer health checks cannot authenticate, so
    // /api/health must be in PUBLIC or middleware 307-redirects it to /login and
    // the probe is useless. Regression guard for that exact bug.
    expect(middleware).toContain("'/api/health'");
  });

  it('excludes crawler and PWA files from the matcher so they are never guarded', () => {
    // robots.txt/sitemap.xml are fetched by search engines and manifest.webmanifest/
    // sw.js by PWA install + service-worker registration — all unauthenticated. If
    // the matcher guards them, middleware 307s each to /login and indexing, install,
    // offline mode, and web push break silently. Regression guard for that exact bug.
    // Backslashes are stripped so the assertion reads as filenames, not as the
    // regex escaping they carry inside the matcher string.
    const matcher = middleware.slice(middleware.indexOf('matcher:')).replace(/\\/g, '');
    for (const file of ['robots.txt', 'sitemap.xml', 'manifest.webmanifest', 'sw.js']) {
      expect(matcher, file).toContain(file);
    }
  });

  it('keeps the route-level boundary explicit in the source', () => {
    expect(middleware).toContain('rate-limit');
    expect(middleware).toContain('Provider webhooks');
  });
});
