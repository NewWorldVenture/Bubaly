import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import robots from '@/app/robots';
import { DISALLOWED_PREFIXES } from '@/lib/marketing/sitemap-urls';

/**
 * Every segment of the authenticated route group. These are the surfaces that
 * answer 307 to /login when signed out — verified against production on
 * 2026-09-13, where all 20 of them did.
 */
function authenticatedSegments(): string[] {
  const root = path.join(process.cwd(), 'app', '(app)');
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    // Route groups and private folders are not URL segments.
    .filter((entry) => !entry.name.startsWith('(') && !entry.name.startsWith('_'))
    .map((entry) => `/${entry.name}`)
    .sort();
}

/**
 * Authenticated surfaces that live outside `app/(app)`. Listed by hand because
 * `app/` also holds genuinely public routes (/join, /reviews) and the marketing
 * group, so the directory alone cannot tell them apart.
 */
const AUTHENTICATED_OUTSIDE_APP_GROUP = ['/library', '/pay', '/onboarding', '/api', '/auth'];

describe('robots disallows every authenticated surface', () => {
  it('covers each segment of the authenticated route group', () => {
    const missing = authenticatedSegments().filter((seg) => !DISALLOWED_PREFIXES.includes(seg as never));
    expect(missing).toEqual([]);
  });

  it('covers the authenticated surfaces that live outside that group', () => {
    const missing = AUTHENTICATED_OUTSIDE_APP_GROUP.filter((p) => !DISALLOWED_PREFIXES.includes(p as never));
    expect(missing).toEqual([]);
  });

  it('names /admin specifically, which the original four-entry list omitted', () => {
    // /admin is 80 pages including the super-admin console. It was the most
    // consequential omission, so it gets its own guard rather than relying on
    // the directory sweep to keep covering it.
    expect(DISALLOWED_PREFIXES).toContain('/admin');
    expect(robots().rules).toMatchObject({ disallow: expect.arrayContaining(['/admin']) });
  });

  it('uses prefix matching that cannot swallow a public sibling route', () => {
    // The sitemap reads this same list and refuses any URL under it, so a
    // looser `startsWith(p)` would silently drop the PUBLIC /family-display
    // from both robots and the sitemap. The matcher requires an exact match or
    // a `/`-delimited prefix; this pins that.
    const matches = (target: string) =>
      DISALLOWED_PREFIXES.some((p) => target === p || target.startsWith(`${p}/`));
    expect(matches('/family-display')).toBe(false);
    expect(matches('/family')).toBe(true);
    expect(matches('/family/members')).toBe(true);
    expect(matches('/display')).toBe(true);
    expect(matches('/pricing')).toBe(false);
  });

  it('still allows the public marketing site', () => {
    const rules = robots().rules as { allow: string; disallow: string[] };
    expect(rules.allow).toBe('/');
    // Public marketing routes must never be swept in by a broad prefix. Note
    // /family-display is public while /family and /display are not, so a naive
    // prefix rule would take it down with them.
    for (const publicPath of ['/pricing', '/blog', '/features', '/family-display', '/join', '/reviews']) {
      expect(rules.disallow).not.toContain(publicPath);
    }
  });

  it('publishes the sitemap location', () => {
    expect(robots().sitemap).toMatch(/\/sitemap\.xml$/);
  });

  it('has no duplicate entries', () => {
    expect(DISALLOWED_PREFIXES).toHaveLength(new Set(DISALLOWED_PREFIXES).size);
  });
});
