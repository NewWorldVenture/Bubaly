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
const healthPage = fs.readFileSync('app/(app)/admin/marketing/health/page.tsx', 'utf8');

// One exported action's own source, from its signature to its closing brace, so
// a gate or a write that belongs to a neighbouring action cannot satisfy a check.
function actionBody(name: string): string {
  const signature = `export async function ${name}(formData: FormData) {\n`;
  const start = actions.indexOf(signature);
  expect(start, `${name} must be an exported action`).toBeGreaterThan(-1);
  const end = actions.indexOf('\n}\n', start);
  expect(end, `${name} must close`).toBeGreaterThan(start);
  return actions.slice(start + signature.length, end);
}

// The gate is the action's first statement: nothing runs before it.
const GATE_FIRST = /^ {2}const \{ supabase, actorId, actorEmail \} = await requireMarketingAdmin\(\);\n/;

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

  it('each SEO write action opens with its own gate and makes its own Supabase write', () => {
    const addKeyword = actionBody('addKeyword');
    expect(addKeyword).toMatch(GATE_FIRST);
    expect(addKeyword).toContain("await supabase.from('marketing_seo_keywords').insert({");

    const saveSeoPage = actionBody('saveSeoPage');
    expect(saveSeoPage).toMatch(GATE_FIRST);
    expect(saveSeoPage).toContain("await supabase.from('marketing_seo_pages').update(values)");
    expect(saveSeoPage).toMatch(/await supabase\.from\('marketing_seo_pages'\)\s*\.upsert\(\{ path, \.\.\.values \}/);
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

  it('each AEO add/update/delete action opens with its own gate and makes its own Supabase write', () => {
    const addAeoQuestion = actionBody('addAeoQuestion');
    expect(addAeoQuestion).toMatch(GATE_FIRST);
    expect(addAeoQuestion).toContain("await supabase.from('marketing_aeo_questions').insert({");

    const updateAeoQuestion = actionBody('updateAeoQuestion');
    expect(updateAeoQuestion).toMatch(GATE_FIRST);
    expect(updateAeoQuestion).toContain("await supabase.from('marketing_aeo_questions').update({");

    const deleteAeoQuestion = actionBody('deleteAeoQuestion');
    expect(deleteAeoQuestion).toMatch(GATE_FIRST);
    expect(deleteAeoQuestion).toContain("await supabase.from('marketing_aeo_questions').delete().eq('id', id)");
  });
});

describe('Marketing SEO/AEO pages load fast — bounded, projected reads (not select all rows)', () => {
  it('AEO derives stats from COUNT queries and renders a bounded, projected list', () => {
    // The table holds thousands of rows — fetching/rendering all of them was slow.
    expect(aeoPage).toContain("count: 'exact', head: true");
    expect(aeoPage).toMatch(/\.limit\(LIST_LIMIT\)/);
    // No unbounded select-* of the whole questions table.
    expect(aeoPage).not.toMatch(/from\('marketing_aeo_questions'\)\.select\('\*'\)/);
  });

  it('SEO fetches a bounded, projected keyword slice + a COUNT for the true total', () => {
    expect(seoPage).toContain("count: 'exact', head: true");
    expect(seoPage).toMatch(/\.limit\(KEYWORD_LIMIT\)/);
    expect(seoPage).not.toMatch(/from\('marketing_seo_keywords'\)\.select\('\*'\)/);
  });
});

describe('Marketing Customer Health fails closed on a read error (no false-empty)', () => {
  it('uses the error-returning reader and renders an error state, not "no customers"', () => {
    // Previously used getMarketingCustomers (drops the error → [] on failure), so a
    // transient DB blip rendered "No customers yet" and hid every at-risk family.
    expect(healthPage).toContain('getMarketingCustomersWithError(');
    expect(healthPage).not.toMatch(/=\s*await getMarketingCustomers\(/);
    expect(healthPage).toContain('CustomerHealthReadError');
  });
});
