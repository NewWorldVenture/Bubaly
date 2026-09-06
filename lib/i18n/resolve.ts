// lib/i18n/resolve.ts — which locale a given request should render in.
//
// Kept pure (plain inputs, no next/headers) so the precedence rules can be unit
// tested without a request, and so middleware, server components and route
// handlers all resolve identically instead of each growing their own variant.

import {
  DEFAULT_LOCALE,
  type Locale,
  localeForAcceptLanguage,
  localeForCountry,
  localeOrDefault,
  findLocale,
} from '@/lib/i18n/locales';

export type LocaleSource = 'cookie' | 'geo' | 'accept-language' | 'default';

export type ResolvedLocale = {
  locale: Locale;
  /** Which signal decided it — surfaced in the picker so a visitor can tell a
   *  guess from their own choice, and used by tests to prove precedence. */
  source: LocaleSource;
};

export type LocaleSignals = {
  /** Value of the locale cookie, if the visitor has ever chosen. */
  cookie?: string | null;
  /** Two-letter country from the CDN edge (Vercel's x-vercel-ip-country). */
  country?: string | null;
  /** The request's Accept-Language header. */
  acceptLanguage?: string | null;
};

/**
 * Resolve a request's locale.
 *
 * Precedence, highest first:
 *   1. cookie          — an explicit choice. Always wins; being relocated or
 *                        travelling must never silently override a person who
 *                        has already told us what they read.
 *   2. geo             — where the request comes from. This is the "identify
 *                        the location you are in" default.
 *   3. accept-language — what the browser says they read. Weaker than geo for a
 *                        family product (a US-configured laptop in Mexico City
 *                        is likelier a Spanish-speaking household than an
 *                        English one), but far better than nothing.
 *   4. default         — en-US.
 *
 * An unrecognised cookie value is ignored rather than trusted, so a stale or
 * hand-edited cookie degrades to detection instead of breaking the render.
 */
export function resolveLocale(signals: LocaleSignals): ResolvedLocale {
  const chosen = findLocale(signals.cookie);
  if (chosen) return { locale: chosen, source: 'cookie' };

  const geo = localeForCountry(signals.country);
  if (geo) return { locale: geo, source: 'geo' };

  const header = localeForAcceptLanguage(signals.acceptLanguage);
  if (header) return { locale: header, source: 'accept-language' };

  return { locale: localeOrDefault(DEFAULT_LOCALE), source: 'default' };
}
