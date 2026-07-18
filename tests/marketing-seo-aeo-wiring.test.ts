import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Super Admin → Marketing SEO/AEO (direct user request): the SEO and AEO buttons
// must point at /admin/marketing/seo and /admin/marketing/aeo (→ the same paths
// under https://www.bubaly.com in production), and both pages must be wired to
// Supabase on the read AND write paths (no dead/mock screens). These guards lock
// the navigation targets and the Supabase wiring in.

const dashboard = fs.readFileSync('app/(app)/admin/marketing/page.tsx', 'utf8');
const subnav = fs.readFileSync('app/(app)/admin/marketing/marketing-subnav.tsx', 'utf8');
const seoPage = fs.readFileSync('app/(app)/admin/marketing/seo/page.tsx', 'utf8');
const aeoPage = fs.readFileSync('app/(app)/admin/marketing/aeo/page.tsx', 'utf8');
const actions = fs.readFileSync('app/(app)/admin/marketing/actions.ts', 'utf8');

describe('Marketing SEO/AEO buttons point to the right admin routes', () => {
  it('the subnav links both pages', () => {
    expect(subnav).toContain("['/admin/marketing/seo', 'SEO']");
    expect(subnav).toContain("['/admin/marketing/aeo', 'AEO']");
  });

  it('the marketing dashboard exposes BOTH a SEO and an AEO quick-link', () => {
    expect(dashboard).toContain('href="/admin/marketing/seo"');
    expect(dashboard).toContain('href="/admin/marketing/aeo"');
  });
});

describe('Marketing SEO page is wired to Supabase (read + write)', () => {
  it('reads keywords + pages via the service client', () => {
    expect(seoPage).toContain('createServiceClient()');
    expect(seoPage).toContain("from('marketing_seo_keywords')");
    expect(seoPage).toContain("from('marketing_seo_pages')");
    // Fails closed on a read error rather than rendering a false-empty page.
    expect(seoPage).toContain('AdminSeoReadError');
  });

  it('write actions persist to Supabase behind the marketing-admin gate', () => {
    expect(actions).toContain("from('marketing_seo_keywords')");
    expect(actions).toContain("from('marketing_seo_pages')");
    expect(actions).toMatch(/addKeyword[\s\S]*?requireMarketingAdmin\(\)/);
    expect(actions).toMatch(/saveSeoPage[\s\S]*?requireMarketingAdmin\(\)/);
  });
});

describe('Marketing AEO page is wired to Supabase (read + write)', () => {
  it('reads questions via the service client and fails closed', () => {
    expect(aeoPage).toContain('createServiceClient()');
    expect(aeoPage).toContain("from('marketing_aeo_questions')");
    expect(aeoPage).toContain('AdminAeoReadError');
  });

  it('add/update/delete actions persist to Supabase behind the marketing-admin gate', () => {
    expect(actions).toMatch(/addAeoQuestion[\s\S]*?requireMarketingAdmin\(\)/);
    expect(actions).toMatch(/addAeoQuestion[\s\S]*?from\('marketing_aeo_questions'\)\.insert/);
    expect(actions).toMatch(/deleteAeoQuestion[\s\S]*?from\('marketing_aeo_questions'\)\.delete/);
  });
});
