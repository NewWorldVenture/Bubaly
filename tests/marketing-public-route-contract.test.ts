import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(process.cwd(), 'app', '(marketing)');
const UTILITY_NO_INDEX_ROUTES = new Set(['demo/upgrade/page.tsx']);

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
