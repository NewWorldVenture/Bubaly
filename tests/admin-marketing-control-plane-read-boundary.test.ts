import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const seo = readFileSync('app/(app)/admin/marketing/seo/page.tsx', 'utf8');
const aeo = readFileSync('app/(app)/admin/marketing/aeo/page.tsx', 'utf8');
const landingPages = readFileSync('app/(app)/admin/marketing/landing-pages/page.tsx', 'utf8');
const funnels = readFileSync('app/(app)/admin/marketing/funnels/page.tsx', 'utf8');
const settings = readFileSync('app/(app)/admin/marketing/settings/page.tsx', 'utf8');
const audit = readFileSync('app/(app)/admin/marketing/audit/page.tsx', 'utf8');
const actions = readFileSync('app/(app)/admin/marketing/actions.ts', 'utf8');

describe('admin marketing control-plane read boundaries', () => {
  it('preserves SEO and AEO read failures instead of showing empty inventories', () => {
    // PLA-0832 (agent-05) consolidated the SEO reads under a single `readError`
    // guard (was `keywordsError`) that renders <AdminSeoReadError/>; the
    // fail-closed message + behaviour are unchanged.
    expect(seo).toContain('readError');
    expect(seo).toContain('Could not load SEO keywords from Supabase. Refresh and try again.');
    expect(aeo).toContain('questionsError');
    expect(aeo).toContain('Could not load AEO questions from Supabase. Refresh and try again.');
  });

  it('preserves landing-page and funnel list failures before publish or create actions', () => {
    expect(landingPages).toContain('pagesError');
    expect(landingPages).toContain('Could not load landing pages from Supabase. Refresh and try again.');
    expect(funnels).toContain('funnelsError');
    expect(funnels).toContain('Could not load marketing funnels from Supabase. Refresh and try again.');
  });

  it('preserves settings and audit-log failures for operators', () => {
    expect(settings).toContain('settingsError');
    expect(settings).toContain('Could not load marketing settings from Supabase. Refresh and try again.');
    expect(audit).toContain('logsError');
    expect(audit).toContain('Could not load marketing audit logs from Supabase. Refresh and try again.');
  });

  it('keeps the admin closed-loop controls wired to guarded mutations', () => {
    expect(landingPages).toContain('updateLandingPage');
    expect(landingPages).toContain('archiveLandingPage');
    expect(aeo).toContain('updateAeoQuestion');
    expect(aeo).toContain('deleteAeoQuestion');
    expect(actions).toContain('Page paths cannot be changed after an audit is created.');
    expect(actions).toContain(".is('deleted_at', null)");
  });
});
