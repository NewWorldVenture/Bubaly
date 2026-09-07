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
 *  Takes a translator rather than returning English: this line renders on the
 *  public marketing pages, where a visitor who picked German should not be told
 *  about "registered families" in English. The number itself is still formatted
 *  by formatFamilies — it is the sentence around it that changes. */
export function familiesNote(
  t: (key: string, params?: Record<string, string | number>) => string,
  n: number,
): string {
  return n <= 0
    ? t('marketing.builtForModernFamilyLife')
    : t('marketing.registeredFamilies', { count: formatFamilies(n) });
}
