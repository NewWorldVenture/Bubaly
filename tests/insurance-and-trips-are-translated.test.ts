import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';
import { POLICY_TYPES, PREMIUM_FREQUENCIES } from '@/lib/insurance/policies';
import { TRIP_ITEM_ADD_KEYS, TRIP_ITEM_KIND_KEYS, TRIP_STATUS_KEYS } from '@/lib/trips/planner';

// I18N-003's last attribute templates composed English constants from lib/:
// the Insurance Hub rendered POLICY_TYPES' and PREMIUM_FREQUENCIES' English
// labels and titled a policy `${label} insurance`, and the Trip Planner
// rendered TRIP_STATUS_LABELS / TRIP_ITEM_KIND_LABELS and titled a modal
// `Add ${kind.toLowerCase()} item`. The policy detail's eight row labels were
// English object values the scanner does not read. The constants stay as
// English identifiers; each entry now carries the catalogue key that is shown.
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const keys = [
  ...POLICY_TYPES.flatMap((p) => [p.labelKey, p.titleKey]),
  ...PREMIUM_FREQUENCIES.flatMap((f) => [f.labelKey, f.shortKey]),
  ...Object.values(TRIP_STATUS_KEYS), ...Object.values(TRIP_ITEM_KIND_KEYS), ...Object.values(TRIP_ITEM_ADD_KEYS),
  'insurance.policyNumberShort', 'insurance.coverage', 'insurance.effective', 'insurance.renews', 'insurance.premiumDetail',
];
const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

describe('the insurance and trip tables carry catalogue keys', () => {
  it('covers every entry (guards the guard)', () => {
    expect(POLICY_TYPES).toHaveLength(12);
    expect(keys.length).toBe(12 * 2 + 4 * 2 + 5 + 4 + 4 + 5);
  });

  it.each(LOCALES)('%s has every key', (locale) => {
    const messages = getMessages(locale);
    expect(keys.filter((k) => !messages[k]?.trim())).toEqual([]);
  });

  it('a German policy reads as German', () => {
    const t = (key: string, params?: Record<string, string | number>) => translate(getMessages('de-DE'), key, params);
    const health = POLICY_TYPES.find((p) => p.value === 'health')!;
    expect(t(health.titleKey)).toBe('Krankenversicherung');
    expect(t('insurance.premiumDetail', { amount: '100 $', period: t(PREMIUM_FREQUENCIES[0].shortKey), annual: '1.200 $' })).toBe('100 $ / Monat (1.200 $/Jahr)');
  });
});

describe('the modules render the keys, not the English labels', () => {
  it('insurance-module', () => {
    const src = code('components/modules/insurance-module.tsx');
    expect(src).not.toMatch(/(policyTypeMeta|frequencyMeta)\([^)]*\)\.label\b/);
    expect(src).not.toMatch(/\bmeta\.label\b|\{[tf]\.label\}/);
    expect(src).not.toMatch(/label: '(Insurer|Policy #|Covers|Premium|Coverage|Deductible|Effective|Renews)'/);
  });

  it('trips-module', () => {
    const src = code('components/modules/trips-module.tsx');
    expect(src).not.toMatch(/TRIP_(STATUS|ITEM_KIND)_LABELS\[/);
  });
});
