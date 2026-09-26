// Pure, client-safe formatters for public marketing figures.
// No server imports here so both server and client components can use them.

import { DEFAULT_LOCALE, type LocaleCode } from '@/lib/i18n/locales';

/** Formats a real count for marketing display: exact below 1k, rounded down with a "+" above. */
export function formatFamilies(n: number, locale: LocaleCode = DEFAULT_LOCALE): string {
  // Grouped for the reader. German writes 12.000 where English writes 12,000, and
  // the two marks are SWAPPED between those conventions — so an un-localised
  // grouping on a public page is legible as a different number, not merely styled
  // oddly. This renders on the marketing site, where the visitor picked the locale.
  if (!Number.isSafeInteger(n) || n <= 0) return '0';
  const group = new Intl.NumberFormat(locale);
  if (n >= 1000) return `${group.format(Math.floor(n / 1000) * 1000)}+`;
  return group.format(n);
}

/** A factual public account-count line with an honest pre-launch fallback.
 *
 *  Takes a translator rather than returning English. This renders on the public
 *  marketing pages, where a visitor who picked German should not be told about
 *  "registered families" in English. `lib/` is outside the i18n gate's surfaces
 *  (it scans app/ and components/), which is exactly why this one survived the
 *  lift: nothing was watching. The number is still formatted by formatFamilies —
 *  it is the sentence around it that changes. */
export function familiesNote(
  t: (key: string, params?: Record<string, string | number>) => string,
  n: number,
  locale: LocaleCode = DEFAULT_LOCALE,
): string {
  return !Number.isSafeInteger(n) || n <= 0
    ? t('marketing.builtForModernFamilyLife')
    : t('marketing.registeredFamilies', { count: formatFamilies(n, locale) });
}

/**
 * The smallest recorded complete-or-partial run aggregate the public site prints.
 *
 * Below this the line is HIDDEN, not rounded up and not replaced with a
 * placeholder: hidden is honest, small is honest, invented is not. The number
 * itself comes from `public_handled_stats()` (lib/marketing/stats.ts), which
 * counts both completed and partially completed run statuses across families.
 */
export const HANDLED_PUBLIC_MIN = 25;

/** Same rounding as formatFamilies: exact below 1k, rounded down with a "+" above. */
export function formatHandled(n: number, locale: LocaleCode = DEFAULT_LOCALE): string {
  return formatFamilies(n, locale);
}

/** True when a valid recorded-run count is large enough to print. */
export function meetsHandledFloor(n: number): boolean {
  return Number.isSafeInteger(n) && n >= HANDLED_PUBLIC_MIN;
}

/**
 * The public complete-or-partial run line, or '' when the count is below
 * HANDLED_PUBLIC_MIN. Callers render the line only when this is non-empty, so
 * a site with no recorded runs yet shows no count line.
 *
 * Takes a translator for the same reason familiesNote does: this sentence is
 * read on the public homepage in every language we ship, and `lib/` is
 * outside the i18n gate's surfaces, so an English literal here would never be
 * caught. The number is formatted by formatHandled; the words come from
 * `handledProof.aggregateNote`.
 */
export function handledNote(
  t: (key: string, params?: Record<string, string | number>) => string,
  n: number,
): string {
  if (!meetsHandledFloor(n)) return '';
  return t('handledProof.aggregateNote', { count: formatHandled(n) });
}
