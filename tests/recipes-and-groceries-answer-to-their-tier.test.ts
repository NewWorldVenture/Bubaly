import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FEATURE_CATALOG } from '@/lib/constants/feature-catalog';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// H21 — the sidebar resolves Recipes and Groceries by their catalog tier
// (nav-shared.tsx → featureAccessByTier), so an admin's Tier & Features
// override to Off hides them and a raised tier shows a padlock. The pages
// themselves called requireUserContext() or nothing, so the URL rendered the
// whole module whatever the tier said. Every other household page — pantry,
// declutter, watchlist, language, meals, kitchen — calls requireFeature, and
// tests/paid-features-enforced-server-side.test.ts only sweeps PAID hrefs,
// which these two are not by default.

const h = vi.hoisted(() => ({ required: [] as string[], refuse: null as null | string }));
vi.mock('@/lib/supabase/auth', () => ({
  requireFeature: async (href: string) => {
    h.required.push(href);
    // What the real one does for a family without the feature: it throws
    // (notFound() or a redirect to billing) and nothing below it runs.
    if (h.refuse === href) throw new Error(`NEXT_REDIRECT /dashboard/billing?need=${href}`);
    return { user: { id: 'user-1' }, active: { familyId: 'family-1', role: 'parent', member: { id: 'member-1' }, family: { timezone: 'UTC' } } };
  },
  requireUserContext: async () => { throw new Error('these pages must ask for the feature, not just a session'); },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => createInMemorySupabase() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const PAGES = [
  ['app/(app)/dashboard/recipes/page.tsx', '/dashboard/recipes'],
  ['app/(app)/dashboard/recipes/discover/page.tsx', '/dashboard/recipes'],
  ['app/(app)/dashboard/recipes/vote/page.tsx', '/dashboard/recipes'],
  ['app/(app)/dashboard/grocery/page.tsx', '/dashboard/grocery'],
] as const;

const page = async (file: string) => ((await import(`@/${file.replace(/\.tsx$/, '')}`)) as { default: () => Promise<unknown> }).default;

beforeEach(() => { h.required = []; h.refuse = null; vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('Recipes and Groceries answer to the tier the sidebar shows', () => {
  it('the hrefs these pages guard are the catalog\'s own', () => {
    const hrefs = new Set(FEATURE_CATALOG.map((feature) => feature.href));
    expect(hrefs.has('/dashboard/recipes')).toBe(true);
    expect(hrefs.has('/dashboard/grocery')).toBe(true);
  });

  it.each(PAGES)('%s asks for %s before rendering', async (file, href) => {
    await page(file).then((render) => render());
    expect(h.required).toEqual([href]);
  });

  it.each(PAGES)('%s renders nothing for a family the tier refuses', async (file, href) => {
    h.refuse = href;
    await expect(page(file).then((render) => render())).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it('every page under recipes/ and grocery/ carries the guard', () => {
    const pages: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'page.tsx') pages.push(full);
      }
    };
    walk('app/(app)/dashboard/recipes');
    walk('app/(app)/dashboard/grocery');
    expect(pages.length).toBeGreaterThanOrEqual(4);
    const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const file of pages) expect(strip(fs.readFileSync(file, 'utf8')), file).toMatch(/requireFeature\('\/dashboard\/(recipes|grocery)'\)/);
  });
});
