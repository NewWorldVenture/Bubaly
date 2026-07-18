import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('marketing closed loop — AEO/SEO wired public ↔ admin', () => {
  const mig0228 = read('supabase/migrations/0228_marketing_public_aeo_and_content_registry.sql');
  const mig0229 = read('supabase/migrations/0229_seed_marketing_aeo_seo.sql');
  const faq = read('app/(marketing)/faq/page.tsx');
  const article = read('app/(marketing)/blog/[slug]/page.tsx');
  const reader = read('lib/marketing/aeo.ts');

  it('exposes ONLY published AEO questions to the public', () => {
    expect(mig0228).toMatch(/CREATE POLICY marketing_aeo_public_read/);
    expect(mig0228).toMatch(/FOR SELECT TO anon, authenticated[\s\S]*USING \(status = 'published'\)/);
    expect(mig0228).toMatch(/GRANT SELECT ON public\.marketing_aeo_questions TO anon, authenticated/);
  });

  it('registers every published blog post as a marketing content item', () => {
    expect(mig0228).toMatch(/INSERT INTO public\.marketing_content_items/);
    expect(mig0228).toMatch(/FROM public\.blog_posts/);
    expect(mig0228).toMatch(/kind = 'blog' AND c\.metadata->>'slug' = b\.slug/); // idempotent
  });

  it('seeds a substantial themed AEO + SEO dataset (published)', () => {
    const aeoRows = (mig0229.match(/'published', \d+, now\(\)/g) ?? []).length;
    expect(aeoRows).toBeGreaterThanOrEqual(300);
    expect(mig0229).toMatch(/marketing_seo_keywords/);
    expect(mig0229).toMatch(/marketing_seo_pages/);
    expect(mig0229).toMatch(/AI Family Operating System/); // brand positioning
    expect(mig0229).toMatch(/ON CONFLICT \(keyword, target_path\) DO NOTHING/);
  });

  it('the public FAQ reads the same AEO store (single source of truth)', () => {
    expect(faq).toMatch(/(?:getPublishedAeoQuestions|readPublishedAeoQuestions)/);
    expect(faq).toMatch(/FaqStructuredData/);
    expect(reader).toMatch(/from\('marketing_aeo_questions'\)/);
    expect(reader).toMatch(/\.eq\('status', 'published'\)/);
  });

  it('every blog article gets an on-topic AEO FAQ block + FAQPage schema linking back', () => {
    expect(article).toMatch(/readAeoQuestionsForPath\(`\/blog\/\$\{post\.slug\}`/);
    expect(article).toMatch(/readAeoQuestionsForCategory/);
    expect(article).toMatch(/FaqStructuredData/);
    expect(article).toMatch(/href="\/faq"/); // links back to the Knowledge Center
  });
});
