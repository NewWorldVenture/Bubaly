import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC, PROTECTED, matchesPrefix } from '@/lib/auth/route-access';

// Paths are anchored to the repo root rather than to the process cwd. Vitest
// runs from the root, so a bare relative read works today — but it works by
// coincidence, and `join(__dirname, '..')` is the idiom the older guards in
// this directory already use. Verified by running this file with the cwd
// somewhere else, which ENOENTs on the bare form and passes on this one.
const ROOT = join(__dirname, '..');

/**
 * M-023 has two sides and only one of them was pinned.
 *
 * `public/sw.js` states the invariant: "authenticated HTML is NEVER written to
 * Cache Storage. Cached pages persist unencrypted after logout and would be
 * served offline to whoever next opens the app on a shared/family device."
 * `tests/mobile-sw-auth-cache.test.ts` enforces that thoroughly — six
 * assertions on the precache list, the navigation allowlist, the version bump,
 * the library cache, the API/auth exclusion and the offline fallback.
 *
 * Every one of them is about the SERVICE WORKER. None is about the pages on its
 * allowlist, and the invariant is only true if those pages are public. The
 * worker caches a navigation like this:
 *
 *   fetch(request).then((res) => { if (CACHEABLE_NAV.has(url.pathname)) c.put(request, res.clone()) })
 *
 * `fetch` FOLLOWS redirects, and `cache.put` keys on the ORIGINAL request. So
 * the day `/` starts redirecting a signed-in visitor to `/dashboard` — an
 * entirely ordinary product change, and the first thing most apps do — the
 * worker stores the dashboard's HTML under the key `/`, and hands it to the
 * next person who opens the app offline on that device. Every assertion in the
 * existing file still passes, and the invariant comment still sits there saying
 * the opposite.
 *
 * So this file asserts the other half: a path the worker may cache must be
 * public by the router's own list, and the components that render it must not
 * read the session or redirect.
 */

const SW = readFileSync(join(ROOT, 'public/sw.js'), 'utf8');

/** The navigation allowlist, read out of the worker rather than restated. */
function cacheableNav(): string[] {
  const shell = /const APP_SHELL\s*=\s*\[([^\]]*)\]/.exec(SW);
  if (!shell) return [];
  return shell[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/**
 * What renders each cacheable path, root layout outwards. Explicit rather than
 * derived: resolving an App Router segment chain by convention is exactly the
 * kind of cleverness that fails open, and a list that must name real files
 * cannot fail open — rule 3 below deletes that possibility.
 */
const RENDER_CHAIN: Record<string, string[]> = {
  '/': ['app/layout.tsx', 'app/(marketing)/layout.tsx', 'app/(marketing)/page.tsx'],
  '/offline': ['app/layout.tsx', 'app/offline/page.tsx'],
};

/**
 * Reading the session is what turns a public page into an authenticated one;
 * `redirect(` is here because it is the subtler half of the same thing — the
 * worker follows the redirect and caches the destination under the original
 * key, so a page that merely FORWARDS a signed-in visitor leaks just as much as
 * one that renders their data.
 */
const SESSION_READ = /\bgetUser\(|\brequireUserContext\b|\bgetUserContext\b|\bcreateServer\(|\bredirect\(/;

describe('a page the service worker may cache must stay public', () => {
  it('reads the allowlist out of the worker (guards the guard)', () => {
    // A parser that silently found nothing would make every rule below vacuous.
    const paths = cacheableNav();
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(paths).toContain('/');
  });

  it('every cacheable path is public by the router’s own list', () => {
    for (const path of cacheableNav()) {
      expect(matchesPrefix(path, PUBLIC), `${path} is cached but is not on PUBLIC`).toBe(true);
      expect(
        matchesPrefix(path, PROTECTED),
        `${path} is cached AND on PROTECTED — the worker would store an authenticated page`,
      ).toBe(false);
    }
  });

  it('every cacheable path names the files that render it', () => {
    // The ratchet: a path added to APP_SHELL fails here until somebody says what
    // renders it, which is the moment to notice it is not a marketing page.
    for (const path of cacheableNav()) {
      const chain = RENDER_CHAIN[path];
      expect(chain, `${path} is cacheable but has no render chain recorded`).toBeDefined();
      for (const file of chain ?? []) {
        expect(existsSync(join(ROOT, file)), `${path}: ${file} does not exist`).toBe(true);
      }
    }
  });

  it('nothing in a cacheable render chain reads the session or redirects', () => {
    const offenders: string[] = [];
    for (const path of cacheableNav()) {
      for (const file of RENDER_CHAIN[path] ?? []) {
        const source = readFileSync(join(ROOT, file), 'utf8');
        const hit = SESSION_READ.exec(source);
        if (hit) offenders.push(`${path}: ${file} uses ${hit[0]}`);
      }
    }
    expect(
      offenders,
      'the service worker caches these paths, and `fetch` follows redirects while '
      + '`cache.put` keys on the original request — so a session read or a redirect '
      + 'here puts authenticated HTML in Cache Storage under a public key, where it '
      + 'survives logout and is served to the next person on a shared device (M-023):\n'
      + offenders.map((o) => `  ${o}`).join('\n'),
    ).toEqual([]);
  });

  it('recognises the shapes it is looking for (calibrates the matcher)', () => {
    // Checked against the real spellings rather than trusted, because a matcher
    // that recognised none of them would pass the rule above forever.
    expect(SESSION_READ.test('const { data: auth } = await supabase.auth.getUser();')).toBe(true);
    expect(SESSION_READ.test('const ctx = await requireUserContext();')).toBe(true);
    expect(SESSION_READ.test('const supabase = await createServer();')).toBe(true);
    expect(SESSION_READ.test("if (user) redirect('/dashboard');")).toBe(true);
    // And not on ordinary marketing-page source.
    expect(SESSION_READ.test("import { Hero } from '@/components/marketing/hero';")).toBe(false);
  });
});
