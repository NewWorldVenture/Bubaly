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

/** e.g. "Loved by 1,000+ families" — falls back to a number-free line when there are none yet. */
export function familiesHeadline(n: number): string {
  return n <= 0 ? 'Loved by families everywhere' : `Loved by ${formatFamilies(n)} families`;
}

/** e.g. "1,000+ families and growing" */
export function familiesNote(n: number): string {
  return n <= 0 ? 'A growing community of families' : `${formatFamilies(n)} families and growing`;
}

/** e.g. "1,000+ families love Bubaly" */
export function familiesLoveLine(n: number): string {
  return n <= 0 ? 'Families love Bubaly' : `${formatFamilies(n)} families love Bubaly`;
}
