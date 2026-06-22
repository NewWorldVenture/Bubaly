import { describe, it, expect } from 'vitest';
import { splitFullName, joinName, normalizePhone, isLikelyPhone } from '@/lib/onboarding/profile';

describe('splitFullName', () => {
  it('splits first and last', () => {
    expect(splitFullName('Ada Lovelace')).toEqual({ firstName: 'Ada', lastName: 'Lovelace' });
  });
  it('keeps multi-word surnames together', () => {
    expect(splitFullName('Maria del Carmen')).toEqual({ firstName: 'Maria', lastName: 'del Carmen' });
  });
  it('handles a single name', () => {
    expect(splitFullName('Cher')).toEqual({ firstName: 'Cher', lastName: '' });
  });
  it('handles empty / nullish', () => {
    expect(splitFullName('')).toEqual({ firstName: '', lastName: '' });
    expect(splitFullName(null)).toEqual({ firstName: '', lastName: '' });
    expect(splitFullName('   ')).toEqual({ firstName: '', lastName: '' });
  });
});

describe('joinName', () => {
  it('joins first and last', () => {
    expect(joinName('Ada', 'Lovelace')).toBe('Ada Lovelace');
  });
  it('drops empty parts and trims', () => {
    expect(joinName('  Ada  ', '')).toBe('Ada');
    expect(joinName('', 'Lovelace')).toBe('Lovelace');
    expect(joinName('', '')).toBe('');
  });
});

describe('normalizePhone', () => {
  it('strips formatting, keeps digits', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('5551234567');
  });
  it('preserves a single leading + for international', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('+15551234567');
  });
  it('returns empty for no digits', () => {
    expect(normalizePhone('abc')).toBe('');
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
  });
});

describe('isLikelyPhone', () => {
  it('accepts 7–15 digit numbers', () => {
    expect(isLikelyPhone('555-1234')).toBe(true);
    expect(isLikelyPhone('+1 555 123 4567')).toBe(true);
  });
  it('rejects too-short / too-long / empty', () => {
    expect(isLikelyPhone('12345')).toBe(false);
    expect(isLikelyPhone('1234567890123456')).toBe(false);
    expect(isLikelyPhone('')).toBe(false);
  });
});
