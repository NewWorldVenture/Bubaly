import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const STATIC_ROUTES = [
  ['app/(marketing)/page.tsx', '/'],
  ['app/(marketing)/features/page.tsx', '/features'],
  ['app/(marketing)/how-it-works/page.tsx', '/how-it-works'],
  ['app/(marketing)/ai/page.tsx', '/ai'],
  ['app/(marketing)/mobile/page.tsx', '/mobile'],
  ['app/(marketing)/security/page.tsx', '/security'],
  ['app/(marketing)/contact/page.tsx', '/contact'],
  ['app/(marketing)/pricing/page.tsx', '/pricing'],
  ['app/(marketing)/privacy/page.tsx', '/privacy'],
  ['app/(marketing)/terms/page.tsx', '/terms'],
  ['app/(marketing)/cookies/page.tsx', '/cookies'],
  ['app/(marketing)/acceptable-use/page.tsx', '/acceptable-use'],
] as const;

describe('static marketing AEO coverage', () => {
  it('has one shared Supabase-backed public AEO section', () => {
    const section = read('components/marketing/marketing-aeo-section.tsx');
    const reader = read('lib/marketing/aeo.ts');
    const schema = read('components/marketing/structured-data.tsx');
    expect(section).toContain('readAeoQuestionsForPath');
    expect(section).toContain('FAQAccordion');
    expect(section).toContain('MarketingPageStructuredData');
    expect(reader).toContain("from('marketing_pages')");
    expect(reader).toContain(".eq('status', 'published')");
    expect(reader).toContain(".is('deleted_at', null)");
    expect(schema).toContain("'@type': 'WebPage'");
  });

  it('wires every indexable static route to the shared section', () => {
    for (const [file, path] of STATIC_ROUTES) {
      const source = read(file);
      expect(source, file).toContain(file.includes('privacy') || file.includes('terms') || file.includes('cookies') || file.includes('acceptable-use') ? 'LegalPage' : 'MarketingAeoSection');
      expect(source, file).toContain(`path="${path}"`);
    }
  });

  it('does not loosen intentionally noindex utility routes', () => {
    expect(read('app/(marketing)/f/[id]/page.tsx')).toContain('index: false');
    expect(read('app/(marketing)/demo/upgrade/page.tsx')).toContain('index: false');
  });
});
