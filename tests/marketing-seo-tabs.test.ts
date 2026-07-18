import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('marketing SEO console — 3 switchable tabs', () => {
  const page = read('app/(app)/admin/marketing/seo/page.tsx');
  const tabs = read('app/(app)/admin/marketing/seo/seo-tabs.tsx');

  it('renders the three required tabs', () => {
    expect(page).toMatch(/<SeoTabs/);
    for (const label of ['Indexable pages', 'SEO Page Registry', 'Tracked keywords']) {
      expect(page).toContain(`label: '${label}'`);
    }
  });

  it('the tab switcher is an accessible, client-side toggle (no refetch)', () => {
    expect(tabs).toMatch(/'use client'/);
    expect(tabs).toMatch(/role="tablist"/);
    expect(tabs).toMatch(/role="tab"/);
    expect(tabs).toMatch(/aria-selected=\{selected\}/);
    expect(tabs).toMatch(/useState/);
  });

  it('keeps each tab wired to its data + server actions', () => {
    // indexable → sitemap/robots; registry → saveSeoPage; keywords → addKeyword
    expect(page).toMatch(/sitemap\.xml/);
    expect(page).toMatch(/action=\{saveSeoPage\}/);
    expect(page).toMatch(/action=\{addKeyword\}/);
  });
});
