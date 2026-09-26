// lib/i18n/locales.ts — the locale catalogue.
//
// Bubaly is region-aware, not just language-aware: a family in Mexico and a
// family in Spain both read Spanish but expect different dates, currency and
// vocabulary, so the unit here is a full BCP-47 locale, never a bare language.
//
// `region` drives the two-letter badge in the picker and the geo default;
// `language` drives the Accept-Language fallback when we know the visitor's
// language but not a matching region.

export type LocaleCode =
  | 'en-US' | 'en-GB'
  | 'de-DE'
  | 'es-ES' | 'es-MX' | 'es-US'
  | 'fr-FR' | 'fr-CA'
  | 'it-IT'
  | 'nl-NL'
  | 'pt-PT';

export type Locale = {
  code: LocaleCode;
  /** ISO 639-1 language subtag. */
  language: string;
  /** ISO 3166-1 alpha-2 region subtag — also the badge shown in the picker. */
  region: string;
  /** The language endonym, as speakers write it. Never translated. */
  nativeLanguage: string;
  /** The country endonym, as speakers write it. Never translated. */
  nativeRegion: string;
  /** Writing direction. All current locales are LTR; the field exists so adding
   *  Arabic or Hebrew is a data change rather than a code change. */
  dir: 'ltr' | 'rtl';
};

/** Display order in the picker: the default first, then alphabetical by endonym. */
export const LOCALES: Locale[] = [
  { code: 'en-US', language: 'en', region: 'US', nativeLanguage: 'English',    nativeRegion: 'United States',  dir: 'ltr' },
  { code: 'de-DE', language: 'de', region: 'DE', nativeLanguage: 'Deutsch',    nativeRegion: 'Deutschland',    dir: 'ltr' },
  { code: 'en-GB', language: 'en', region: 'GB', nativeLanguage: 'English',    nativeRegion: 'United Kingdom', dir: 'ltr' },
  { code: 'es-ES', language: 'es', region: 'ES', nativeLanguage: 'Español',    nativeRegion: 'España',         dir: 'ltr' },
  { code: 'es-MX', language: 'es', region: 'MX', nativeLanguage: 'Español',    nativeRegion: 'México',         dir: 'ltr' },
  { code: 'es-US', language: 'es', region: 'US', nativeLanguage: 'Español',    nativeRegion: 'Estados Unidos', dir: 'ltr' },
  { code: 'fr-CA', language: 'fr', region: 'CA', nativeLanguage: 'Français',   nativeRegion: 'Canada',         dir: 'ltr' },
  { code: 'fr-FR', language: 'fr', region: 'FR', nativeLanguage: 'Français',   nativeRegion: 'France',         dir: 'ltr' },
  { code: 'it-IT', language: 'it', region: 'IT', nativeLanguage: 'Italiano',   nativeRegion: 'Italia',         dir: 'ltr' },
  { code: 'nl-NL', language: 'nl', region: 'NL', nativeLanguage: 'Nederlands', nativeRegion: 'Nederland',      dir: 'ltr' },
  { code: 'pt-PT', language: 'pt', region: 'PT', nativeLanguage: 'Português',  nativeRegion: 'Portugal',       dir: 'ltr' },
];

export const DEFAULT_LOCALE: LocaleCode = 'en-US';

/** Cookie the visitor's explicit choice is stored in. Readable by the server on
 *  the very first render, so a chosen language never flashes English first. */
export const LOCALE_COOKIE = 'bubaly-locale';

/** One year: a language preference is not a session-scoped thing. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const BY_CODE = new Map<string, Locale>(LOCALES.map((l) => [l.code.toLowerCase(), l]));

/** True when `value` is a locale we actually ship. */
export function isLocaleCode(value: string | undefined | null): value is LocaleCode {
  return !!value && BY_CODE.has(value.toLowerCase());
}

/** The catalogue entry for a code, or undefined when we don't ship it. */
export function findLocale(value: string | undefined | null): Locale | undefined {
  return value ? BY_CODE.get(value.toLowerCase()) : undefined;
}

/** The catalogue entry for a code, falling back to the default. */
export function localeOrDefault(value: string | undefined | null): Locale {
  return findLocale(value) ?? findLocale(DEFAULT_LOCALE)!;
}

/**
 * The best locale for a visitor in `country`, or undefined when we ship nothing
 * for it. Regions we serve directly win; otherwise a country that shares a
 * language gets that language (a visitor in Austria reads German, in Argentina
 * Spanish) rather than being dropped to English.
 */
export function localeForCountry(country: string | undefined | null): Locale | undefined {
  if (!country) return undefined;
  const cc = country.toUpperCase();

  // The explicit map is consulted FIRST, because some countries have more than
  // one locale carrying their region code and array order must never be what
  // decides between them: Canada matches both fr-CA and the en-US mapping, and
  // the United States matches both en-US and es-US. Falling through to the scan
  // there would hand every Canadian visitor French.
  const mapped = findLocale(COUNTRY_LOCALE[cc]);
  if (mapped) return mapped;

  return LOCALES.find((l) => l.region === cc);
}

/**
 * Countries without a catalogue entry of their own, mapped to the locale their
 * visitors are best served by — a full locale, not a bare language, because the
 * code selects FORMATTING as well as wording, and a family in Argentina should
 * read Argentine dates and amounts whatever language the words around them are
 * in.
 *
 * WHAT THE REGIONAL CODES SELECT TODAY, AND WHAT THEY DO NOT. This block used to
 * justify itself by saying the regional choice was meaningful in VOCABULARY —
 * that Latin America read Mexican Spanish rather than Spain's. It does not, and
 * a test now holds this paragraph to that. es-MX is an EMPTY overlay —
 * three bytes, `{}`, declared in PLACEHOLDER_LOCALES in lib/i18n/messages.ts and
 * held there by a test — so the seventeen countries mapped to it read Spain's
 * Spanish word for word, with Mexican dates and numbers around it. The same goes
 * for the eight mapped to en-GB, for PR (es-US) and for HT (fr-CA): TWENTY-SEVEN
 * of the forty-six countries below route to a catalogue that is empty.
 *
 * The mapping itself is still the right one and is doing real work — it is what
 * a populated overlay would need, and the formatting half of it is live for
 * every country here. But for those twenty-seven it selects formatting ONLY, and
 * this comment now says that rather than claiming a vocabulary that is not
 * there. See I18N-009.
 *
 * Deliberately conservative: only places with an unambiguous majority language
 * we actually ship. Anywhere absent falls through to Accept-Language, then
 * English — a wrong guess is worse than no guess, since the visitor can always
 * pick for themselves.
 */
const COUNTRY_LOCALE: Record<string, LocaleCode> = {
  // German
  AT: 'de-DE', CH: 'de-DE', LI: 'de-DE', LU: 'de-DE',
  // Spanish — Latin America to the Mexican locale. Its catalogue is empty, so
  // today that means Peninsular words with Mexican dates and numbers.
  AR: 'es-MX', BO: 'es-MX', CL: 'es-MX', CO: 'es-MX', CR: 'es-MX', CU: 'es-MX',
  DO: 'es-MX', EC: 'es-MX', GT: 'es-MX', HN: 'es-MX', NI: 'es-MX', PA: 'es-MX',
  PE: 'es-MX', PY: 'es-MX', SV: 'es-MX', UY: 'es-MX', VE: 'es-MX',
  // Puerto Rico is US-adjacent Spanish.
  PR: 'es-US',
  // French — European French for Europe and francophone Africa; Canada has its own.
  BE: 'fr-FR', MC: 'fr-FR', SN: 'fr-FR', CI: 'fr-FR', CM: 'fr-FR', HT: 'fr-CA',
  // Portuguese. Brazil reads pt-BR, which we do not yet ship; pt-PT is far
  // closer than English, so it is the honest fallback until pt-BR exists.
  BR: 'pt-PT', AO: 'pt-PT', MZ: 'pt-PT',
  // Dutch
  SR: 'nl-NL', AW: 'nl-NL', CW: 'nl-NL', BQ: 'nl-NL',
  // English-speaking regions without a catalogue entry: Commonwealth spelling
  // to en-GB, the Americas and Asia-Pacific business English to en-US.
  IE: 'en-GB', AU: 'en-GB', NZ: 'en-GB', ZA: 'en-GB', IN: 'en-GB', NG: 'en-GB',
  KE: 'en-GB', SG: 'en-GB',
  PH: 'en-US',

  // Countries that need an explicit entry because more than one locale carries
  // their region code, and the wrong one is a bad default:
  //   CA — we ship fr-CA, but Canada is roughly three-quarters anglophone.
  //        Francophone visitors are caught by Accept-Language (their browsers
  //        send fr-CA) and can pick it from the menu regardless.
  //   US — we ship es-US alongside en-US.
  CA: 'en-US',
  US: 'en-US',
};

/**
 * The best locale for an `Accept-Language` header, or undefined when none of the
 * visitor's languages is one we ship. Honours q-values, prefers an exact
 * region match, then any locale sharing the language.
 */
export function localeForAcceptLanguage(header: string | undefined | null): Locale | undefined {
  if (!header) return undefined;

  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith('q='));
      const quality = q ? Number.parseFloat(q.slice(2)) : 1;
      return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((entry) => entry.tag && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of ranked) {
    const exact = findLocale(tag);
    if (exact) return exact;

    const language = tag.split('-')[0]?.toLowerCase();
    if (!language) continue;
    const primary = findLocale(PRIMARY_LOCALE[language]);
    if (primary) return primary;
  }
  return undefined;
}

/**
 * Which locale a bare language tag resolves to (`es` with no region → es-ES).
 * Explicit rather than "first match in LOCALES", so reordering the picker can
 * never silently change what an Accept-Language header resolves to.
 */
const PRIMARY_LOCALE: Record<string, LocaleCode> = {
  en: 'en-US',
  de: 'de-DE',
  es: 'es-ES',
  fr: 'fr-FR',
  it: 'it-IT',
  nl: 'nl-NL',
  pt: 'pt-PT',
};
