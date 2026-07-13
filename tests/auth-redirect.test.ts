import { describe, expect, it } from 'vitest';
import { safeInternalRedirect } from '@/lib/auth/redirect';

describe('safeInternalRedirect', () => {
  it.each([
    ['/home', '/home'],
    ['/join?token=abc#invite', '/join?token=abc#invite'],
    ['/dashboard/../pricing', '/pricing'],
  ])('allows and normalizes application path %s', (value, expected) => {
    expect(safeInternalRedirect(value, '/fallback')).toBe(expected);
  });

  it.each([
    null,
    '',
    'https://evil.example',
    '//evil.example/path',
    '/\\evil.example/path',
    '\\evil.example/path',
    '/%2f%2fevil.example/path',
    '/%5cevil.example/path',
    'javascript:alert(1)',
  ])('rejects unsafe destination %s', (value) => {
    expect(safeInternalRedirect(value, '/fallback')).toBe('/fallback');
  });
});
