import { describe, expect, it } from 'vitest';
import {
  HANDLED_PUBLIC_MIN,
  formatFamilies,
  familiesNote,
  formatHandled,
  handledNote,
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
    expect(handledNote(n)).toBe(expected);
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
    expect(handledNote(Number.NaN)).toBe('');
  });
});
