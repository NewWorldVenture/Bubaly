import { describe, it, expect } from 'vitest';
import {
  normalizeEmail, normalizeVisitorId, normalizeSlug, formatLikeCount, normalizeSource,
} from '@/lib/blog/engagement';

describe('normalizeEmail', () => {
  it('lowercases and trims a valid email', () => {
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
  });
  it('rejects non-strings and malformed shapes', () => {
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();          // no TLD
    expect(normalizeEmail('a b@c.com')).toBeNull();    // whitespace
    expect(normalizeEmail('a..b@c.com')).toBeNull();   // consecutive dots
    expect(normalizeEmail('a@b.c')).toBeNull();        // 1-char TLD
  });
  it('bounds length', () => {
    expect(normalizeEmail(`${'x'.repeat(250)}@example.com`)).toBeNull();
    expect(normalizeEmail('a@b.co')).toBe('a@b.co');
  });
});

describe('normalizeVisitorId', () => {
  it('accepts UUIDs and the fallback id shape', () => {
    expect(normalizeVisitorId('0b39b0af-9184-42a3-b344-63a318f7d924')).toBe('0b39b0af-9184-42a3-b344-63a318f7d924');
    expect(normalizeVisitorId('v-lqz8k3-a1b2c3d4')).toBe('v-lqz8k3-a1b2c3d4');
  });
  it('rejects short, long, or hostile ids', () => {
    expect(normalizeVisitorId('short')).toBeNull();
    expect(normalizeVisitorId('x'.repeat(101))).toBeNull();
    expect(normalizeVisitorId("abc'; DROP TABLE--")).toBeNull();
    expect(normalizeVisitorId(null)).toBeNull();
  });
});

describe('normalizeSlug', () => {
  it('accepts kebab-case slugs', () => {
    expect(normalizeSlug('the-sunday-reset')).toBe('the-sunday-reset');
    expect(normalizeSlug('ai-family-life')).toBe('ai-family-life');
  });
  it('rejects anything else', () => {
    expect(normalizeSlug('Has Spaces')).toBeNull();
    expect(normalizeSlug('UPPER-case')).toBeNull();
    expect(normalizeSlug('-leading')).toBeNull();
    expect(normalizeSlug('trailing-')).toBeNull();
    expect(normalizeSlug('a')).toBeNull();
    expect(normalizeSlug(`${'a-'.repeat(70)}b`)).toBeNull();
  });
});

describe('formatLikeCount', () => {
  it('renders small counts directly and abbreviates large ones', () => {
    expect(formatLikeCount(0)).toBe('0');
    expect(formatLikeCount(-3)).toBe('0');
    expect(formatLikeCount(999)).toBe('999');
    expect(formatLikeCount(1000)).toBe('1k');
    expect(formatLikeCount(1234)).toBe('1.2k');
    expect(formatLikeCount(9999)).toBe('9.9k');
    expect(formatLikeCount(12_345)).toBe('12k');
    expect(formatLikeCount(1_234_567)).toBe('1.2m');
  });
});

describe('normalizeSource', () => {
  it('allows only known sources, defaulting to blog', () => {
    expect(normalizeSource('article')).toBe('article');
    expect(normalizeSource('blog-sidebar')).toBe('blog-sidebar');
    expect(normalizeSource('blog-footer')).toBe('blog-footer');
    expect(normalizeSource('evil')).toBe('blog');
    expect(normalizeSource(undefined)).toBe('blog');
  });
});
