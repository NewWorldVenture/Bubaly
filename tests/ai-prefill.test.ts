import { describe, it, expect } from 'vitest';
import { parsePrefillQuery } from '@/lib/ai/prefill';

describe('parsePrefillQuery', () => {
  it('extracts a q value with or without a leading ?', () => {
    expect(parsePrefillQuery('?q=plan%20dinner')).toBe('plan dinner');
    expect(parsePrefillQuery('q=hello')).toBe('hello');
  });

  it('returns null for absent or blank q', () => {
    expect(parsePrefillQuery('')).toBeNull();
    expect(parsePrefillQuery('?foo=bar')).toBeNull();
    expect(parsePrefillQuery('?q=')).toBeNull();
    expect(parsePrefillQuery('?q=%20%20')).toBeNull();
  });

  it('trims and caps length', () => {
    expect(parsePrefillQuery('?q=' + encodeURIComponent('  spaced  '))).toBe('spaced');
    expect(parsePrefillQuery('?q=' + 'a'.repeat(2000), 100)).toHaveLength(100);
  });
});
