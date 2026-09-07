import { describe, expect, it } from 'vitest';
import {
  HANDLED_PUBLIC_MIN,
  formatFamilies,
  familiesNote,
  formatHandled,
  handledNote,
  meetsHandledFloor,
} from '@/lib/marketing/format';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import DE_MESSAGES from '@/lib/i18n/messages/de-DE.json';

// The note formatters take a translator, because their sentences render on the
// public marketing pages and a German visitor should not be told about
// "registered families" in English. Resolving through the real catalogues keeps
// these assertions checking the words a visitor sees rather than a key.
const through = (messages: Record<string, string>) =>
  (key: string, params?: Record<string, string | number>) =>
    Object.entries(params ?? {}).reduce(
      (out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
      messages[key] ?? key,
    );
const t = through(SOURCE_MESSAGES);
const german = through(DE_MESSAGES as Record<string, string>);

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
    expect(familiesNote(german, 0)).toBe(de['marketing.builtForModernFamilyLife']);
    expect(familiesNote(german, 0)).not.toBe('Built for modern family life');
    expect(familiesNote(german, 42)).toContain('42');
    expect(familiesNote(german, 42)).not.toContain('registered families');
  });
});

// The "things Bubaly finished" aggregate: hidden below a floor, exact below
// 1k, rounded down above. Hidden is honest, small is honest, invented is not.
describe('marketing handled-count formatters', () => {
  it('sets the public floor at 25', () => {
    expect(HANDLED_PUBLIC_MIN).toBe(25);
  });

  it.each([
    [0, ''],
    [24, ''],
    [25, '25 things finished by Bubaly for real families so far'],
    [999, '999 things finished by Bubaly for real families so far'],
    [1000, '1,000+ things finished by Bubaly for real families so far'],
    [12_345, '12,000+ things finished by Bubaly for real families so far'],
  ])('handledNote(%i) → %j', (n, expected) => {
    expect(handledNote(t, n)).toBe(expected);
  });

  it.each([
    [0, false],
    [24, false],
    [25, true],
    [12_345, true],
    [Number.NaN, false],
  ])('meetsHandledFloor(%d) → %s', (n, expected) => {
    expect(meetsHandledFloor(n)).toBe(expected);
  });

  // Same defect familiesNote had: an English literal in lib/ that the i18n gate
  // cannot see. The line must come out in the visitor's language, and the
  // floor must hide it in every language, not just English.
  it('renders the handled line in the visitor\'s language and hides it below the floor', () => {
    const de = DE_MESSAGES as Record<string, string>;
    expect(handledNote(german, 24)).toBe('');
    expect(handledNote(german, 1000)).toBe(de['handledProof.aggregateNote'].replace('{count}', '1,000+'));
    expect(handledNote(german, 1000)).not.toContain('things finished');
  });

  it.each([
    [0, '0'],
    [24, '24'],
    [25, '25'],
    [999, '999'],
    [1000, '1,000+'],
    [12_345, '12,000+'],
  ])('formatHandled(%i) → %s', (n, expected) => {
    expect(formatHandled(n)).toBe(expected);
  });

  it('never renders a line for a non-number', () => {
    expect(handledNote(t, Number.NaN)).toBe('');
  });
});
