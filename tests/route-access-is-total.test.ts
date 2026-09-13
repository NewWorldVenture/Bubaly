import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROTECTED, PUBLIC, matchesPrefix } from '@/lib/auth/route-access';

// Middleware used to redirect ANYTHING not on the public list to /login, so a
// path with no route answered 307 to a sign-in form instead of 404 — a login
// form in front of a typo, and a soft 404 for every crawler following a stale
// link. It now redirects only paths on the PROTECTED list, and lets the rest
// fall through to app/not-found.tsx.
//
// That inverts the safety property. Before, forgetting to classify a route
// left it protected; now it would leave it reachable. This test is what makes
// the new arrangement safe: every routable top-level path must appear on one
// list or the other, so forgetting is a failing test rather than a page that
// renders to strangers.

const ROOT = process.cwd();
const ROUTE_FILES = ['page.tsx', 'page.ts', 'route.ts', 'route.tsx'];

/** Every top-level path the app router can serve, route groups unwrapped. */
function routableTopLevelPaths(): Map<string, string> {
  const found = new Map<string, string>(); // '/wallet' → the directory that proved it
  const walk = (dir: string, segments: string[]) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && ROUTE_FILES.includes(e.name))) {
      const path = segments.length ? `/${segments[0]}` : '/';
      if (!found.has(path)) found.set(path, dir.replace(`${ROOT}/`, ''));
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      // (marketing) and friends group files without adding a URL segment.
      const grouped = entry.name.startsWith('(') && entry.name.endsWith(')');
      // @modal and _private directories are not routable segments either.
      if (entry.name.startsWith('@') || entry.name.startsWith('_')) continue;
      walk(join(dir, entry.name), grouped ? segments : [...segments, entry.name]);
    }
  };
  walk(join(ROOT, 'app'), []);
  return found;
}

describe('every routable path is classified', () => {
  const routes = routableTopLevelPaths();

  it('finds the app, so a broken walk cannot pass by finding nothing', () => {
    expect(routes.size).toBeGreaterThan(40);
    expect([...routes.keys()]).toContain('/dashboard');
    expect([...routes.keys()]).toContain('/blog');
  });

  it('has no path that is neither public nor protected', () => {
    const unclassified = [...routes]
      .filter(([path]) => !matchesPrefix(path, PUBLIC) && !matchesPrefix(path, PROTECTED))
      .map(([path, dir]) => `${path}  (${dir})`);
    // A new route lands here. Decide: add it to PUBLIC if it must render
    // signed-out, or to PROTECTED if it needs a session. Leaving it out now
    // means it renders to anyone.
    expect(unclassified).toEqual([]);
  });

  it('keeps every authenticated app segment protected', () => {
    // The (app) group is the authenticated surface; none of it may drift onto
    // the public list or off the protected one.
    const appDir = join(ROOT, 'app', '(app)');
    const segments = readdirSync(appDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('(') && !e.name.startsWith('_'))
      .map((e) => `/${e.name}`)
      // `auth` under (app) is the signed-in callback surface, already covered
      // by the public /auth entry it shares a path with.
      .filter((s) => s !== '/auth');
    for (const segment of segments) {
      expect(matchesPrefix(segment, PROTECTED), `${segment} must be protected`).toBe(true);
      expect(matchesPrefix(segment, PUBLIC), `${segment} must not be public`).toBe(false);
    }
  });
});

describe('matchesPrefix', () => {
  it('matches a path and anything beneath it', () => {
    expect(matchesPrefix('/wallet', ['/wallet'])).toBe(true);
    expect(matchesPrefix('/wallet/send', ['/wallet'])).toBe(true);
  });

  it('does not match a sibling that merely shares a prefix', () => {
    // /walletsomething must not be treated as /wallet.
    expect(matchesPrefix('/walletsomething', ['/wallet'])).toBe(false);
  });

  it('treats the root as the root and nothing else', () => {
    // '/' matches only itself: the prefix test looks for '//', which no real
    // path starts with. Every other page earns its own entry.
    expect(matchesPrefix('/', ['/'])).toBe(true);
    expect(matchesPrefix('/anything', ['/'])).toBe(false);
  });
});

describe('the lists themselves', () => {
  it('protects the authenticated surfaces that live outside (app)', () => {
    for (const path of ['/onboarding', '/library']) {
      expect(matchesPrefix(path, PROTECTED)).toBe(true);
    }
  });

  it('leaves a public path nested under a protected prefix reachable', () => {
    // /api is protected, but its webhooks and marketing endpoints are public;
    // middleware checks public first, which this encodes.
    expect(matchesPrefix('/api/webhooks/stripe', PUBLIC)).toBe(true);
    expect(matchesPrefix('/api/webhooks/stripe', PROTECTED)).toBe(true);
  });

  it('classifies an invented path as neither, so it will 404', () => {
    for (const path of ['/nope', '/some-random-thing', '/.env', '/wp-admin']) {
      expect(matchesPrefix(path, PUBLIC), path).toBe(false);
      expect(matchesPrefix(path, PROTECTED), path).toBe(false);
    }
  });
});
