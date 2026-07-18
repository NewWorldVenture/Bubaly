import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const mig = readFileSync(join(ROOT, 'supabase/migrations/0236_seed_blog_seo_registry.sql'), 'utf8');
const article = readFileSync(join(ROOT, 'app/(marketing)/blog/[slug]/page.tsx'), 'utf8');

describe('0236 — every blog article in the SEO Page Registry', () => {
  it('registers one marketing_seo_pages row per published blog post', () => {
    expect(mig).toMatch(/INSERT INTO public\.marketing_seo_pages/);
    expect(mig).toMatch(/'\/blog\/' \|\| b\.slug/);
    expect(mig).toMatch(/FROM public\.blog_posts b/);
    expect(mig).toMatch(/WHERE b\.published/);
  });

  it('stores SEO title, bounded meta description, keywords, canonical, intent', () => {
    expect(mig).toMatch(/left\(regexp_replace\(b\.excerpt/); // bounded description
    expect(mig).toMatch(/'keywords',/);
    expect(mig).toMatch(/'canonical', 'https:\/\/www\.bubaly\.com\/blog\/' \|\| b\.slug/);
    expect(mig).toMatch(/'search_intent', 'informational'/);
    expect(mig).toMatch(/'category', b\.category/);
  });

  it('is idempotent (ON CONFLICT (path) DO UPDATE)', () => {
    expect(mig).toMatch(/ON CONFLICT \(path\) DO UPDATE SET/);
  });

  it('the article page resolves its metadata through the registry (closed loop)', () => {
    expect(article).toMatch(/resolveMarketingMetadata\(`\/blog\/\$\{post\.slug\}`/);
    expect(article).toMatch(/from '@\/lib\/marketing\/seo'/);
  });
});
