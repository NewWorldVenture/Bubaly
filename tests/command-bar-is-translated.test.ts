import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';
import { navLabel } from '@/lib/i18n/nav-label';
import { NAV_CATALOG } from '@/lib/constants/navigation';
import { routeCommand } from '@/lib/command-bar/route';

// I18N-004, the command-bar half. The bar rendered the router's labels as they
// came: English nav labels ("Pantry"), English capture labels ("Added task:
// “…”"), "Ask Bubaly: “…”" and nine English intent calls to action. And it
// matched the query against the English labels only, so a German family
// typing "Vorrat" found nothing. The router keeps English identifiers; the bar
// matches and renders the catalogue.
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const bar = readFileSync('components/app/command-bar.tsx', 'utf8');
const intents = readFileSync('lib/intent/detect.ts', 'utf8');
const de = (key: string, params?: Record<string, string | number>) => translate(getMessages('de-DE'), key, params);

describe('the command bar speaks the family\'s language', () => {
  it('a German family finds the calendar by its German name', () => {
    const items = NAV_CATALOG.map((n) => ({ href: n.href, label: navLabel(de, n.label) }));
    expect(items.find((i) => i.href === '/dashboard/calendar')?.label).toBe('Kalender');
    const hit = routeCommand('Kalender', items).find((r) => r.kind === 'navigate');
    expect(hit).toMatchObject({ kind: 'navigate', href: '/dashboard/calendar', label: 'Kalender' });
    // The English catalogue the bar used to match against finds nothing for it.
    expect(routeCommand('Kalender', NAV_CATALOG.map((n) => ({ href: n.href, label: n.label }))).some((r) => r.kind === 'navigate')).toBe(false);
  });

  it('every intent the detector can return has a translated call to action', () => {
    const detected = [...new Set([...intents.matchAll(/intent: '([a-z_]+)'/g)].map((m) => m[1]))];
    expect(detected.length).toBeGreaterThanOrEqual(9);
    const mapped = new Map([...bar.matchAll(/(\w+): '(commandBarIntent\.\w+)'/g)].map((m) => [m[1], m[2]]));
    expect(detected.filter((i) => !mapped.has(i))).toEqual([]);
    for (const locale of LOCALES) {
      const messages = getMessages(locale);
      expect([...mapped.values()].filter((k) => !messages[k]?.trim()), locale).toEqual([]);
    }
  });

  it('renders every result through labelOf, not the router\'s English label', () => {
    expect(bar).toContain('const label = labelOf(r);');
    expect(bar).toMatch(/navLabel\(t, n\.label\)/);
    expect(bar).not.toMatch(/`\$\{res\.count\} items added`/);
    expect(bar).not.toContain("label: 'Undo'");
    expect(de('commandBar.routeWithText', { route: de('voiceModule.routeTask'), text: 'Milch' })).toBe(`${de('voiceModule.routeTask')}: „Milch“`);
  });
});
