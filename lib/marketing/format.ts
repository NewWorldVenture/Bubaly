// Pure, client-safe formatters for public marketing figures.
// No server imports here so both server and client components can use them.

/** Formats a real count for marketing display: exact below 1k, rounded down with a "+" above. */
export function formatFamilies(n: number): string {
  if (n <= 0) return '0';
  if (n >= 1000) {
    const rounded = Math.floor(n / 1000) * 1000;
    return `${rounded.toLocaleString('en-US')}+`;
  }
  return n.toLocaleString('en-US');
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
): string {
  return n <= 0
    ? t('marketing.builtForModernFamilyLife')
    : t('marketing.registeredFamilies', { count: formatFamilies(n) });
}

/**
 * The smallest "things Bubaly finished" aggregate the public site will print.
 *
 * Below this the line is HIDDEN, not rounded up and not replaced with a
 * placeholder: hidden is honest, small is honest, invented is not. The number
 * itself comes from `public_handled_stats()` (lib/marketing/stats.ts), which
 * counts runs that reached a finished state across real families and excludes
 * the shared demo account.
 */
export const HANDLED_PUBLIC_MIN = 25;

/** Same rounding as formatFamilies: exact below 1k, rounded down with a "+" above. */
export function formatHandled(n: number): string {
  return formatFamilies(n);
}

/**
 * The public "things finished" line, or '' when the real count is below
 * HANDLED_PUBLIC_MIN. Callers render the line only when this is non-empty, so
 * a site with no runs yet shows nothing rather than "0 things finished".
 */
export function handledNote(n: number): string {
  if (!Number.isFinite(n) || n < HANDLED_PUBLIC_MIN) return '';
  return `${formatHandled(n)} things finished by Bubaly for real families so far`;
}
