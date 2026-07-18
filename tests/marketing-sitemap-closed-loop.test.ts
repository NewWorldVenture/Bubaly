import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'app/sitemap.ts'), 'utf8');

describe('marketing sitemap closed loop', () => {
  it('reads published, non-deleted Super Admin landing pages', () => {
    expect(source).toContain("from('marketing_landing_pages')");
    expect(source).toContain(".eq('published', true)");
    expect(source).toContain(".is('deleted_at', null)");
  });

  it('emits public landing-page URLs without making sitemap generation fatal', () => {
    expect(source).toContain('`' + '${SITE_URL}/lp/${encodeURIComponent(page.slug)}`');
    expect(source).toContain("console.error('[sitemap] published landing-page read failed'");
    expect(source).toContain('return [...staticEntries, ...categoryEntries, ...postEntries, ...landingEntries, ...platformEntries]');
  });
});
