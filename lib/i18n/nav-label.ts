/**
 * The catalogue key for a navigation label (I18N-004).
 *
 * `lib/constants/navigation.ts` names every destination in English, and those
 * strings are also identifiers (group titles are compared, labels feed search
 * and tests), so they stay as they are. What the sidebar SHOWS is the catalogue
 * entry derived from the label: 'Backup & Restore' -> 'navLabel.backupRestore'.
 * tests/navigation-is-translated.test.ts fails if any label lacks an entry in
 * any catalogue, so the derived key is never shown raw.
 */
export function navLabelKey(label: string): string {
  const words = label.replace(/[’']/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const camel = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  return `navLabel.${camel}`;
}

/** The label in the viewer's language. */
export function navLabel(t: (key: string, params?: Record<string, string | number>) => string, label: string): string {
  return t(navLabelKey(label));
}
