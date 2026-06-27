import { describe, it, expect } from 'vitest';
import { slugify, publishedOnly, clampRating } from '@/lib/marketing/reputation';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('The Rivera Family Saved 6 Hours!')).toBe('the-rivera-family-saved-6-hours');
  });
  it('trims hyphens and handles empties', () => {
    expect(slugify('  Hello  ')).toBe('hello');
    expect(slugify('!!!')).toBe('item');
    expect(slugify('')).toBe('item');
  });
});

describe('publishedOnly', () => {
  it('keeps published, sorted by sort_order', () => {
    const out = publishedOnly([
      { is_published: true, sort_order: 2, id: 'b' },
      { is_published: false, sort_order: 0, id: 'x' },
      { is_published: true, sort_order: 1, id: 'a' },
    ]);
    expect(out.map((o) => o.id)).toEqual(['a', 'b']);
  });
});

describe('clampRating', () => {
  it('clamps to 1–5 and rounds', () => {
    expect(clampRating(7)).toBe(5);
    expect(clampRating(0)).toBe(1);
    expect(clampRating(4.4)).toBe(4);
  });
  it('null for missing/invalid', () => {
    expect(clampRating(null)).toBeNull();
    expect(clampRating(undefined)).toBeNull();
    expect(clampRating(NaN)).toBeNull();
  });
});
