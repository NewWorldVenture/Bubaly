// NAV-L01: the Auto and Home sub-menus, the Marketplace menu, the More page
// (labels and their descriptions), the dashboard names and descriptions in the
// sidebar, switcher and Settings, and the Settings navigation intro were English
// in every language. The main sidebar already translated its labels through
// navLabel (I18N-004, tests/navigation-is-translated.test.ts); these surfaces
// rendered theirs raw. They now use the same mechanism, and this pins it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { navLabelKey } from '@/lib/i18n/nav-label';
import { DASHBOARD_DESCRIPTION_KEYS, DASHBOARD_VIEWS, dashboardLabel } from '@/lib/constants/dashboards';
import { ROLE_ORDER } from '@/lib/constants/roles';

const CODES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const catalogues = Object.fromEntries(CODES.map((code) => [code, JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8')) as Record<string, string>]));
const MENUS = [
  'components/auto/auto-subnav.tsx',
  'components/home/home-subnav.tsx',
  'components/marketplace/marketplace-nav.tsx',
  'app/(app)/dashboard/more/page.tsx',
];
const labelsOf = (source: string) => [...source.matchAll(/\blabel: '([^']+)'/g)].map((m) => m[1]);

describe('a sub-menu is in the reader\'s language', () => {
  it.each(MENUS)('%s renders its labels through navLabel, never raw', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(/(?<!key=)\{(item|it|row|r|i)\.label\}/);
    expect(source).toMatch(/navLabel\(t, (item|it|row)\.label\)/);
    expect(labelsOf(source).length).toBeGreaterThan(0);
  });

  it('every menu label, dashboard name and description is in every full catalogue', () => {
    const keys = new Set<string>();
    for (const file of MENUS) for (const label of labelsOf(readFileSync(file, 'utf8'))) keys.add(navLabelKey(label));
    for (const view of DASHBOARD_VIEWS) {
      keys.add(DASHBOARD_DESCRIPTION_KEYS[view]);
      for (const role of ROLE_ORDER) keys.add(navLabelKey(dashboardLabel(view, role)));
    }
    for (const sub of readFileSync('app/(app)/dashboard/more/page.tsx', 'utf8').matchAll(/sub: '([^']+)'/g)) keys.add(sub[1]);
    keys.add('navigationChoices.intro');
    for (const code of CODES) for (const key of keys) expect(catalogues[code][key], `${code} ${key}`).toBeTruthy();
  });

  it('the dashboard name and description are never shown raw', () => {
    for (const file of ['components/app/app-shell.tsx', 'components/modules/settings-module.tsx', 'components/dashboard/personal-dashboard.tsx']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\{(dashboardLabel|personalDashboardLabel)\(/);
      expect(source, file).not.toMatch(/DASHBOARD_DESCRIPTIONS\[/);
    }
    expect(readFileSync('components/settings/navigation-choices.tsx', 'utf8')).not.toMatch(/Choose which destinations appear/);
  });
});

describe('the social sub-menu and the marketplace trust score', () => {
  it('the social sections render through navLabel and are in every catalogue', () => {
    expect(readFileSync('components/social/subnav.tsx', 'utf8')).toMatch(/navLabel\(t, item\.label\)/);
    for (const label of labelsOf(readFileSync('app/(app)/dashboard/social/layout.tsx', 'utf8'))) {
      for (const code of CODES) expect(catalogues[code][navLabelKey(label)], `${code} ${label}`).toBeTruthy();
    }
  });

  it('the trust band, the listing count and a failed read are said in the reader\'s language', async () => {
    const { TRUST_BAND_LABEL_KEYS } = await import('@/lib/marketplace/trust');
    const widget = readFileSync('components/marketplace/sidebar-trust-score.tsx', 'utf8');
    expect(widget).not.toMatch(/item\$\{|List an item to start/);
    // A failed read shows a message, never a zero-baseline score.
    expect(widget).toMatch(/if \(reviews\.error \|\| orders\.error \|\| listings\.error\)/);
    expect(widget).toMatch(/if \(failed\)/);
    const keys = [...Object.values(TRUST_BAND_LABEL_KEYS), 'sidebarTrustScore.oneItemListed', 'sidebarTrustScore.itemsListed', 'sidebarTrustScore.listAnItem', 'sidebarTrustScore.couldNotLoad'];
    for (const code of CODES) for (const key of keys) expect(catalogues[code][key], `${code} ${key}`).toBeTruthy();
  });
});
