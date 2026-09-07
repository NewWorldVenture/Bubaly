import { describe, expect, it } from 'vitest';
import {
  formatFamilies,
  familiesNote,
} from '@/lib/marketing/format';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import DE_MESSAGES from '@/lib/i18n/messages/de-DE.json';

// These guard the public marketing copy: counts must reflect real data and must
// NEVER fall back to a fabricated number when there are zero families.
describe('marketing family-count formatters', () => {
  it('renders 0 (never an invented number) when there are no families', () => {
    expect(formatFamilies(0)).toBe('0');
    expect(formatFamilies(-5)).toBe('0');
  });

  it('shows exact counts below 1,000', () => {
    expect(formatFamilies(7)).toBe('7');
    expect(formatFamilies(999)).toBe('999');
  });

  it('rounds down to a "+" milestone at/above 1,000', () => {
    expect(formatFamilies(1000)).toBe('1,000+');
    expect(formatFamilies(1999)).toBe('1,000+');
    expect(formatFamilies(12_345)).toBe('12,000+');
  });

  // familiesNote now takes a translator, because this line renders on the public
  // marketing pages and a German visitor should not be told about "registered
  // families" in English. Resolving through the real English catalogue keeps
  // these assertions checking the words a visitor sees rather than a key.
  const t = (key: string, params?: Record<string, string | number>) =>
    Object.entries(params ?? {}).reduce(
      (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
      SOURCE_MESSAGES[key] ?? key,
    );

  it('uses honest fallback copy when count is zero', () => {
    expect(familiesNote(t, 0)).toBe('Built for modern family life');
  });

  it('uses the real registered-family count when families exist', () => {
    expect(familiesNote(t, 42)).toBe('42 registered families');
  });

  // The defect this guards: familiesNote returned an English literal, so every
  // locale read "42 registered families" on the public pricing page. lib/ sits
  // outside the i18n gate's surfaces, which is why nothing caught it.
  it('renders the count line in the visitor\'s language', () => {
    const de = DE_MESSAGES as Record<string, string>;
    const german = (key: string, params?: Record<string, string | number>) =>
      Object.entries(params ?? {}).reduce(
        (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
        de[key] ?? key,
      );
    expect(familiesNote(german, 0)).toBe(de['marketing.builtForModernFamilyLife']);
    expect(familiesNote(german, 0)).not.toBe('Built for modern family life');
    expect(familiesNote(german, 42)).toContain('42');
    expect(familiesNote(german, 42)).not.toContain('registered families');
  });
});
