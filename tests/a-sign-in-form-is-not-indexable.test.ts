import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DISALLOWED_PREFIXES } from '@/lib/marketing/sitemap-urls';

/**
 * Audit C1-S9-15 — every page under `app/(auth)` must make its indexability an
 * explicit decision, not an inherited default.
 *
 * There are two mechanisms, and a page is covered if EITHER applies: a
 * `DISALLOWED_PREFIXES` entry in robots.txt (which is how `/auth/*` is handled),
 * or `robots: { index: false }` in its own metadata (how `/login` and `/signup`
 * are). `/kid-login` had neither, which made a children's sign-in form the one
 * crawlable, indexable login surface in the product while its adult sibling was
 * explicitly excluded.
 *
 * `/welcome` is listed as a deliberate EXCEPTION rather than quietly fixed: it
 * is a pre-signup onboarding card, plausibly a page the product WANTS indexed,
 * and that is a product call rather than an audit one. Naming it here means the
 * decision is visible instead of absent — which was the whole defect.
 */
const AUTH_DIR = 'app/(auth)';
const INDEXABLE_ON_PURPOSE: Record<string, string> = {
  '/welcome': 'a pre-signup onboarding card; top-of-funnel, so indexing it is a product decision, not an oversight',
};

function authPages(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) authPages(full, out);
    else if (entry.name === 'page.tsx') out.push(full);
  }
  return out;
}

/** `app/(auth)/kid-login/page.tsx` -> `/kid-login` (route groups do not appear in URLs). */
const routeOf = (file: string) =>
  file.replace(/^app/, '').replace(/\/page\.tsx$/, '').replace(/\/\([^/)]*\)/g, '') || '/';

describe('a sign-in form is not indexable by accident (C1-S9-15)', () => {
  const pages = authPages(AUTH_DIR);

  it('finds the auth pages at all', () => {
    // A scan that matches nothing reports no indexable sign-in form.
    expect(pages.length).toBeGreaterThanOrEqual(6);
  });

  it.each(pages)('%s declares its indexability', (file) => {
    const route = routeOf(file);
    if (route in INDEXABLE_ON_PURPOSE) {
      expect(INDEXABLE_ON_PURPOSE[route].length, `${route} needs a reason a reviewer can weigh`).toBeGreaterThan(20);
      return;
    }
    const blockedByRobots = DISALLOWED_PREFIXES.some(
      (prefix) => route === prefix || route.startsWith(`${prefix}/`),
    );
    const noindex = /robots:\s*\{[^}]*index:\s*false/.test(readFileSync(file, 'utf8'));
    expect(
      blockedByRobots || noindex,
      `${route} is neither in DISALLOWED_PREFIXES nor marked noindex — add one, or name it in INDEXABLE_ON_PURPOSE with a reason`,
    ).toBe(true);
  });
});
