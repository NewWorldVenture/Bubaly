import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(process.cwd(), 'app', '(marketing)');

// Demo mode was removed with the /demo routes; there is no longer a public
// marketing page that opts out of the AEO contract, so there is no exception
// list either. A route that wants one has to earn it here, in review.
const UTILITY_NO_INDEX_ROUTES = new Set<string>();

function pageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return pageFiles(file);
    return entry.name === 'page.tsx' ? [file] : [];
  });
}

describe('public marketing route SEO/AEO contract', () => {
  const routes = pageFiles(ROOT);

  it('discovers the complete public marketing route set', () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  it('has no demo route left to exempt', () => {
    const paths = routes.map((file) => relative(ROOT, file).replaceAll('\\', '/'));
    expect(paths.filter((route) => route.startsWith('demo/'))).toEqual([]);
  });

  it.each(routes)('%s has metadata and a page-level AEO/schema contract', (file) => {
    const source = readFileSync(file, 'utf8');
    const route = relative(ROOT, file).replaceAll('\\', '/');
    expect(source, `${route} must define metadata`).toMatch(/generateMetadata|export const metadata/);

    if (UTILITY_NO_INDEX_ROUTES.has(route)) {
      expect(source, `${route} must explicitly stay out of search`).toMatch(/robots:\s*\{\s*index:\s*false/);
      return;
    }

    // LegalPage owns the shared AEO section for all legal documents; dynamic
    // registry routes own it through MarketingPageView.
    expect(source, `${route} must include or delegate to the shared AEO contract`).toMatch(
      /MarketingAeoSection|MarketingPageStructuredData|FaqStructuredData|MarketingPageView|LegalPage/,
    );
  });
});
