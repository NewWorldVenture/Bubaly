import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';

// The printed medical and dental sheets are what a parent hands to a front
// desk. Two things were wrong with them, and both are the kind a screenshot in
// UTC will never show:
//
//   * A birthday is a date-only string. `new Date('2015-03-04')` is UTC
//     midnight, which in any US time zone is the evening of March 3, so the
//     check-in sheet printed the wrong date of birth, and the age turned over
//     a day early. It is read as a calendar date now, and the DST-observing CI
//     job (TZ=America/Los_Angeles) is the one that can see this go red.
//   * Titles and counts were English spliced from a noun ("Dental Providers",
//     "3 providers", "No dental insurance on file"), so a German family
//     printed an English sheet. Each is a catalogue sentence now.
const harness = vi.hoisted(() => ({ locale: 'en-US' as string }));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages(harness.locale as LocaleCode), key, params),
  useLocale: () => localeOrDefault(harness.locale),
}));

const { CheckInSheet, ProviderInfoSheet } = await import('@/components/medical/print-sheet');
afterEach(() => { harness.locale = 'en-US'; vi.useRealTimers(); });

const member = { id: 'm1', display_name: 'Sam', birthday: '2015-03-04' } as never;
const provider = (id: string) => ({ id, name: `Dr ${id}`, is_primary: false, specialty: null, practice_name: null, phone: null, fax: null, email: null, address: null, notes: null }) as never;
const checkIn = (kind: 'medical' | 'dental' = 'medical') => renderToStaticMarkup(createElement(CheckInSheet, {
  kind, member, profile: null, policy: null, providers: [], medications: [], onClose: () => {},
}));

describe('a birthday is a calendar date, not a UTC instant', () => {
  it('prints the date of birth as entered, whatever the host time zone', () => {
    expect(checkIn()).toContain('March 4, 2015');
    expect(checkIn()).not.toContain('March 3, 2015');
  });

  it('turns the age over on the birthday, not the evening before', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 2, 3, 20, 0, 0));  // the evening before, local time
    expect(checkIn()).toContain('Age 10');
    vi.setSystemTime(new Date(2026, 2, 4, 8, 0, 0));   // the morning of
    expect(checkIn()).toContain('Age 11');
  });
});

describe('the sheets are printed in the family\'s language', () => {
  it('a German family gets German titles, counts, and empty states', () => {
    harness.locale = 'de-DE';
    const sheet = checkIn('dental');
    expect(sheet).toContain('4. März 2015');
    expect(sheet).toContain(translate(getMessages('de-DE'), 'medicalRecords.checkInSheetTitleDental'));
    expect(sheet).toContain(translate(getMessages('de-DE'), 'printSheet.noInsuranceOnFileDental'));
    expect(sheet).not.toMatch(/None reported|Not on file|Check-In|No dental/);

    const providers = renderToStaticMarkup(createElement(ProviderInfoSheet, { kind: 'medical', member: null, providers: [provider('a'), provider('b')], onClose: () => {} }));
    expect(providers).toContain(translate(getMessages('de-DE'), 'medicalRecords.providersSheetTitleMedical'));
    expect(providers).toContain(translate(getMessages('de-DE'), 'medicalRecords.wholeFamily'));
    expect(providers).toContain(translate(getMessages('de-DE'), 'medicalRecords.providerCountMany', { n: 2 }));
    expect(providers).not.toMatch(/Providers|Whole Family|>Fax</);
  });

  it('one provider is singular', () => {
    const one = renderToStaticMarkup(createElement(ProviderInfoSheet, { kind: 'dental', member: null, providers: [provider('a')], onClose: () => {} }));
    expect(one).toContain('Whole Family · 1 provider');
    expect(one).toContain('Dental providers');
  });
});
