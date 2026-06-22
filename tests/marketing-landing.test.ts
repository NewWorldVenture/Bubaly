import { describe, expect, it } from 'vitest';
import { landingCta, safeHref, normalizeSlug, bodyParagraphs } from '@/lib/marketing/landing';

describe('landingCta', () => {
  it('falls back to signup when metadata is empty', () => {
    expect(landingCta(null)).toEqual({ label: 'Get started free', href: '/signup' });
    expect(landingCta({})).toEqual({ label: 'Get started free', href: '/signup' });
  });
  it('uses provided label + href', () => {
    expect(landingCta({ cta_label: 'Try it', cta_href: '/pricing' })).toEqual({ label: 'Try it', href: '/pricing' });
  });
  it('rejects unsafe hrefs', () => {
    expect(landingCta({ cta_href: 'javascript:alert(1)' }).href).toBe('/signup');
    expect(landingCta({ cta_href: '//evil.com' }).href).toBe('/signup');
  });
  it('allows absolute http(s)', () => {
    expect(landingCta({ cta_href: 'https://example.com/x' }).href).toBe('https://example.com/x');
  });
});

describe('safeHref', () => {
  it('passes same-origin paths and http(s)', () => {
    expect(safeHref('/signup')).toBe('/signup');
    expect(safeHref('http://a.com')).toBe('http://a.com');
  });
  it('defaults on junk', () => {
    expect(safeHref('')).toBe('/signup');
    expect(safeHref('ftp://x')).toBe('/signup');
  });
});

describe('normalizeSlug', () => {
  it('kebab-cases and trims', () => {
    expect(normalizeSlug('  Summer SALE!! 2026 ')).toBe('summer-sale-2026');
    expect(normalizeSlug('--a--b--')).toBe('a-b');
  });
});

describe('bodyParagraphs', () => {
  it('splits on blank lines', () => {
    expect(bodyParagraphs('one\n\ntwo\n\n\nthree')).toEqual(['one', 'two', 'three']);
    expect(bodyParagraphs(null)).toEqual([]);
  });
});
