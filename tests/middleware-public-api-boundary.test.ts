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
    for (const path of ['/api/cron', '/api/concierge-calls', '/api/guardian', '/api/email/welcome', '/api/webhooks']) {
      expect(middleware, path).toContain(`'${path}'`);
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
