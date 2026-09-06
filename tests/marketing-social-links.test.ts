import { describe, it, expect } from 'vitest';
import {
  normalizeSocialUrl,
  sanitizeSocialLinks,
  SOCIAL_PLATFORMS,
} from '@/lib/marketing/social-links';

// The footer turns these values into hrefs and the homepage publishes them into
// JSON-LD, so what survives sanitization is the whole security boundary here:
// they are admin-entered strings that end up in the DOM of every public page.

describe('normalizeSocialUrl', () => {
  it('keeps a real https profile URL', () => {
    expect(normalizeSocialUrl('https://x.com/bubaly')).toBe('https://x.com/bubaly');
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(normalizeSocialUrl('  https://x.com/bubaly  ')).toBe('https://x.com/bubaly');
  });

  it.each([
    ['javascript:alert(1)', 'the scheme that makes a footer link an XSS vector'],
    ['data:text/html,<script>alert(1)</script>', 'inline document scheme'],
    ['http://x.com/bubaly', 'plaintext http'],
    ['x.com/bubaly', 'no scheme — the most likely admin typo'],
    ['', 'empty'],
    ['   ', 'whitespace only'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizeSocialUrl(input)).toBeNull();
  });

  it('rejects a scheme-only host with no dot, which is never a real profile', () => {
    expect(normalizeSocialUrl('https://localhost')).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(normalizeSocialUrl(42)).toBeNull();
    expect(normalizeSocialUrl(null)).toBeNull();
    expect(normalizeSocialUrl(undefined)).toBeNull();
  });

  it('rejects a URL past the length bound', () => {
    expect(normalizeSocialUrl(`https://x.com/${'a'.repeat(400)}`)).toBeNull();
  });
});

describe('sanitizeSocialLinks', () => {
  it('keeps known platforms and drops unknown ones', () => {
    expect(
      sanitizeSocialLinks({
        facebook: 'https://www.facebook.com/bubaly',
        myspace: 'https://myspace.com/bubaly',
      }),
    ).toEqual({ facebook: 'https://www.facebook.com/bubaly' });
  });

  it('drops a known platform whose URL does not survive normalization', () => {
    expect(
      sanitizeSocialLinks({
        x: 'https://x.com/bubaly',
        instagram: 'javascript:alert(1)',
      }),
    ).toEqual({ x: 'https://x.com/bubaly' });
  });

  it.each([[null], [undefined], ['a string'], [42], [[]]])('returns {} for %s', (input) => {
    expect(sanitizeSocialLinks(input)).toEqual({});
  });

  it('accepts every platform the footer can render', () => {
    const all = Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p.key, `https://example.com/${p.key}`]));
    expect(Object.keys(sanitizeSocialLinks(all)).sort()).toEqual(SOCIAL_PLATFORMS.map((p) => p.key).sort());
  });

  it('ships a usable https placeholder for each platform', () => {
    for (const { key, placeholder } of SOCIAL_PLATFORMS) {
      expect(normalizeSocialUrl(placeholder), key).toBe(placeholder);
    }
  });
});
