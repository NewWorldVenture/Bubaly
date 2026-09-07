import { describe, expect, it } from 'vitest';
import {
  formatFamilies,
  familiesNote,
} from '@/lib/marketing/format';

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

  // familiesNote now renders through the catalogue, so the test drives it with
  // a stub translator: what it locks is which key is chosen and what is
  // interpolated, not the English wording (that lives in en-US.json and is
  // asserted by the catalogue's own parity checks).
  const t = (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key;

  it('uses honest fallback copy when count is zero', () => {
    expect(familiesNote(t, 0)).toBe('marketing.builtForModernFamilyLife');
  });

  it('uses the real registered-family count when families exist', () => {
    expect(familiesNote(t, 42)).toBe('marketing.registeredFamilies:{"count":"42"}');
  });

  it('formats the count before handing it to the translator', () => {
    expect(familiesNote(t, 12_345)).toBe('marketing.registeredFamilies:{"count":"12,000+"}');
  });
});
