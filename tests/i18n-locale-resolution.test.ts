import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCALE,
  LOCALES,
  findLocale,
  isLocaleCode,
  localeForAcceptLanguage,
  localeForCountry,
} from '@/lib/i18n/locales';
import { getMessages, getRawMessages, SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';
import { resolveLocale } from '@/lib/i18n/resolve';

describe('locale resolution precedence', () => {
  it('lets an explicit choice beat both geo and the browser', () => {
    // Someone who has told us what they read must keep reading it while
    // travelling — the whole point of the picker is that it sticks.
    const { locale, source } = resolveLocale({
      cookie: 'de-DE',
      country: 'MX',
      acceptLanguage: 'en-US,en;q=0.9',
    });
    expect(locale.code).toBe('de-DE');
    expect(source).toBe('cookie');
  });

  it('uses where the request comes from before what the browser claims', () => {
    // A US-configured laptop in Mexico City is likelier a Spanish-speaking
    // household than an English one.
    const { locale, source } = resolveLocale({
      country: 'MX',
      acceptLanguage: 'en-US,en;q=0.9',
    });
    expect(locale.code).toBe('es-MX');
    expect(source).toBe('geo');
  });

  it('falls back to Accept-Language when the edge sends no country', () => {
    const { locale, source } = resolveLocale({ acceptLanguage: 'it-IT,it;q=0.9' });
    expect(locale.code).toBe('it-IT');
    expect(source).toBe('accept-language');
  });

  it('falls back to the default when nothing is known', () => {
    const { locale, source } = resolveLocale({});
    expect(locale.code).toBe(DEFAULT_LOCALE);
    expect(source).toBe('default');
  });

  it('ignores a cookie value we do not ship instead of trusting it', () => {
    // A stale or hand-edited cookie must degrade to detection, never break the
    // render or select a locale with no catalogue behind it.
    const { locale, source } = resolveLocale({ cookie: 'xx-YY', country: 'FR' });
    expect(locale.code).toBe('fr-FR');
    expect(source).toBe('geo');
  });
});

describe('country to locale', () => {
  it('prefers a region we serve directly', () => {
    expect(localeForCountry('DE')?.code).toBe('de-DE');
    expect(localeForCountry('GB')?.code).toBe('en-GB');
    expect(localeForCountry('MX')?.code).toBe('es-MX');
  });

  it('sends Latin America to Mexican Spanish, not Peninsular', () => {
    // The regional choice carries real meaning; defaulting the Americas to
    // Spain's Spanish is the classic i18n slip.
    for (const country of ['AR', 'CL', 'CO', 'PE', 'UY']) {
      expect(localeForCountry(country)?.code, country).toBe('es-MX');
    }
    expect(localeForCountry('PR')?.code).toBe('es-US');
  });

  it('routes shared-language countries to the nearest locale we ship', () => {
    expect(localeForCountry('AT')?.code).toBe('de-DE');
    expect(localeForCountry('BE')?.code).toBe('fr-FR');
    expect(localeForCountry('BR')?.code).toBe('pt-PT');
    expect(localeForCountry('IE')?.code).toBe('en-GB');
    expect(localeForCountry('CA')?.code).toBe('en-US');
  });

  it('resolves countries that more than one locale claims', () => {
    // Canada carries fr-CA's region code and the United States carries es-US's,
    // so both would otherwise be decided by whichever entry sits earlier in the
    // catalogue array. Reordering the picker must not change the default a
    // Canadian or American visitor gets.
    expect(localeForCountry('CA')?.code).toBe('en-US');
    expect(localeForCountry('US')?.code).toBe('en-US');
  });

  it('still reaches a minority-language locale through the browser', () => {
    // Defaulting Canada to English must not make fr-CA unreachable: a
    // francophone browser asks for it by name.
    expect(localeForAcceptLanguage('fr-CA,fr;q=0.9')?.code).toBe('fr-CA');
    expect(resolveLocale({ country: 'CA', acceptLanguage: 'fr-CA' }).locale.code).toBe('en-US');
    expect(resolveLocale({ cookie: 'fr-CA', country: 'CA' }).locale.code).toBe('fr-CA');
  });

  it('returns nothing for a country we cannot serve', () => {
    // Better to fall through to Accept-Language than to guess wrong.
    expect(localeForCountry('JP')).toBeUndefined();
    expect(localeForCountry('')).toBeUndefined();
    expect(localeForCountry(null)).toBeUndefined();
  });

  it('is case-insensitive about the country code', () => {
    expect(localeForCountry('de')?.code).toBe('de-DE');
  });
});

describe('Accept-Language parsing', () => {
  it('honours q-values rather than taking the first tag', () => {
    expect(localeForAcceptLanguage('en;q=0.2,fr-FR;q=0.9')?.code).toBe('fr-FR');
  });

  it('prefers an exact locale over one that only shares the language', () => {
    expect(localeForAcceptLanguage('en-GB,en;q=0.8')?.code).toBe('en-GB');
  });

  it('resolves a bare language to its designated primary', () => {
    expect(localeForAcceptLanguage('es')?.code).toBe('es-ES');
    expect(localeForAcceptLanguage('pt')?.code).toBe('pt-PT');
  });

  it('skips languages we do not ship and keeps looking', () => {
    expect(localeForAcceptLanguage('ja,ko;q=0.9,nl;q=0.5')?.code).toBe('nl-NL');
  });

  it('returns nothing when no listed language is one we ship', () => {
    expect(localeForAcceptLanguage('ja,ko;q=0.9')).toBeUndefined();
    expect(localeForAcceptLanguage('')).toBeUndefined();
  });

  it('ignores a language the visitor explicitly refused (q=0)', () => {
    expect(localeForAcceptLanguage('de;q=0')).toBeUndefined();
  });
});

describe('catalogues', () => {
  it('ships a catalogue for every locale the picker offers', () => {
    for (const locale of LOCALES) {
      expect(getMessages(locale.code), locale.code).toBeTruthy();
    }
  });

  it('resolves every source key in every locale', () => {
    // A gap must fall back to English, never render a raw key at a visitor.
    const keys = Object.keys(SOURCE_MESSAGES);
    expect(keys.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      const messages = getMessages(locale.code);
      for (const key of keys) {
        expect(typeof messages[key], `${locale.code} ${key}`).toBe('string');
        expect(messages[key], `${locale.code} ${key}`).not.toBe('');
      }
    }
  });

  it('has no key a translation invented on its own', () => {
    // An orphan key is dead weight that reads as coverage — every key must
    // exist in the source catalogue.
    for (const locale of LOCALES) {
      const orphans = Object.keys(getRawMessages(locale.code)).filter(
        (key) => !(key in SOURCE_MESSAGES),
      );
      expect(orphans, `${locale.code} has keys absent from en-US`).toEqual([]);
    }
  });

  it('inherits a regional overlay from its base language, not from English', () => {
    // es-MX is an overlay carrying only genuine Mexican differences. If the
    // chain were wrong it would fall to English and a Mexican visitor would get
    // a page half in Spanish and half in English.
    const mx = getMessages('es-MX');
    const es = getMessages('es-ES');
    expect(mx['nav.family']).toBe(es['nav.family']);
    expect(mx['nav.family']).not.toBe(SOURCE_MESSAGES['nav.family']);

    const ca = getMessages('fr-CA');
    expect(ca['nav.family']).toBe(getMessages('fr-FR')['nav.family']);
  });

  it('translates British English through to American English', () => {
    expect(getMessages('en-GB')['nav.family']).toBe(SOURCE_MESSAGES['nav.family']);
  });
});

describe('translate', () => {
  it('substitutes named placeholders', () => {
    expect(translate({ greet: 'Hello {name}' }, 'greet', { name: 'Ada' })).toBe('Hello Ada');
  });

  it('leaves a placeholder alone when no value is supplied', () => {
    expect(translate({ greet: 'Hello {name}' }, 'greet', { other: 'x' })).toBe('Hello {name}');
  });

  it('falls back to English, then to the key itself', () => {
    expect(translate({}, 'nav.family')).toBe(SOURCE_MESSAGES['nav.family']);
    expect(translate({}, 'nope.not.a.key')).toBe('nope.not.a.key');
  });
});

describe('locale codes', () => {
  it('accepts what we ship and rejects what we do not', () => {
    expect(isLocaleCode('en-US')).toBe(true);
    expect(isLocaleCode('en-us')).toBe(true);
    expect(isLocaleCode('klingon')).toBe(false);
    expect(isLocaleCode(undefined)).toBe(false);
  });

  it('gives every locale a distinct code and complete display data', () => {
    const codes = LOCALES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const l of LOCALES) {
      expect(l.nativeLanguage, l.code).toBeTruthy();
      expect(l.nativeRegion, l.code).toBeTruthy();
      expect(l.region, l.code).toMatch(/^[A-Z]{2}$/);
      expect(findLocale(l.code)).toBe(l);
    }
  });
});
