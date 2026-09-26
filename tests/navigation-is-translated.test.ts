import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';
import { navLabel, navLabelKey } from '@/lib/i18n/nav-label';
import { SERVICE_CATEGORIES } from '@/lib/constants/service-categories';

// I18N-004. The signed-in sidebar rendered its 194 labels and 5 group titles
// straight from the English constants in lib/constants/navigation.ts, so a
// family using the app in German navigated it in English on every page, and
// the hardcoded-string scanner (which does not read lib/) could not see it.
// Labels stay English as identifiers; what is shown is the catalogue entry
// navLabelKey() derives, and the All Services categories carry literal keys.

const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const nav = readFileSync('lib/constants/navigation.ts', 'utf8');
const labels = [...new Set([...nav.matchAll(/\blabel: '([^']+)'/g)].map((m) => m[1]))];
const titles = [...new Set([...nav.matchAll(/\btitle: '([^']+)'/g)].map((m) => m[1]))];
const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

describe('every navigation label has a translation', () => {
  it('reads the real navigation (guards the guard)', () => {
    expect(labels.length).toBeGreaterThan(150);
    expect(titles).toContain('Suggested');
  });

  it.each(LOCALES)('%s has an entry for every label and group title', (locale) => {
    const messages = getMessages(locale);
    const missing = [...labels, ...titles].filter((l) => !messages[navLabelKey(l)]?.trim());
    expect(missing).toEqual([]);
  });

  it('no two labels share a key', () => {
    const keys = new Map<string, string>();
    for (const l of [...labels, ...titles]) {
      const k = navLabelKey(l);
      expect(keys.get(k) ?? l, k).toBe(l);
      keys.set(k, l);
    }
  });

  it('shows German in a German sidebar', () => {
    const t = (key: string, params?: Record<string, string | number>) => translate(getMessages('de-DE'), key, params);
    expect(navLabel(t, 'Pantry')).toBe('Vorratskammer');
    expect(navLabel(t, 'Suggested')).toBe('Vorgeschlagen');
    expect(t('nav.upgradeToUnlock', { label: navLabel(t, 'Pantry') })).toContain('Vorratskammer');
  });
});

describe('no sidebar renders the English constant', () => {
  it.each(['components/app/app-shell.tsx', 'components/app/nav-shared.tsx', 'components/app/free-tier-sidebar.tsx'])('%s', (f) => {
    const src = code(f);
    expect(src, 'render navLabel(t, item.label)').not.toMatch(/\{(item|child)\.label\}/);
    expect(src, 'render navLabel(t, group.title)').not.toMatch(/>\s*\{group\.title\}\s*</);
    expect(src).not.toMatch(/`[^`]*\$\{item\.label\}[^`]*`/);
    expect(src).not.toContain("'Pin to sidebar'");
  });
});

describe('the All Services pages show translated categories', () => {
  it.each(LOCALES)('%s has every category label and description', (locale) => {
    const messages = getMessages(locale);
    for (const c of SERVICE_CATEGORIES) {
      expect(messages[c.labelKey], `${locale} ${c.labelKey}`).toBeTruthy();
      expect(messages[c.descriptionKey], `${locale} ${c.descriptionKey}`).toBeTruthy();
    }
  });

  it('the hub and the category page render the keys, not the constants', () => {
    for (const f of ['components/services/services-hub.tsx', 'components/services/service-category.tsx']) {
      const src = code(f);
      expect(src, f).not.toMatch(/\{(cat|category)\.(label|description)\}/);
      expect(src, f).not.toMatch(/\{qa\.label\}/);
    }
  });
});
