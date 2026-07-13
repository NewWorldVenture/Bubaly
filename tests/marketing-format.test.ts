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

  it('uses honest fallback copy when count is zero', () => {
    expect(familiesNote(0)).toBe('Built for modern family life');
  });

  it('uses the real registered-family count when families exist', () => {
    expect(familiesNote(42)).toBe('42 registered families');
  });
});
