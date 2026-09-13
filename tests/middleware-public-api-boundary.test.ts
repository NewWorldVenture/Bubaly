import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const middleware = readFileSync('middleware.ts', 'utf8');

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
