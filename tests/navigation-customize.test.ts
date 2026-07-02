import { describe, it, expect } from 'vitest';
import { sanitizeNavKeys, resolveNavKeys, FIXED_NAV_ROUTES } from '@/lib/navigation/customize';

describe('sanitizeNavKeys', () => {
  it('drops non-strings, blanks, and de-dupes (first wins)', () => {
    expect(sanitizeNavKeys(['/home', '', '  ', 42, '/home', '/calendar'])).toEqual(['/home', '/calendar']);
  });
  it('strips the fixed-chrome routes', () => {
    for (const r of FIXED_NAV_ROUTES) {
      expect(sanitizeNavKeys(['/home', r])).toEqual(['/home']);
    }
  });
  it('filters against a valid-key allowlist when given', () => {
    expect(sanitizeNavKeys(['/home', '/nope', '/calendar'], ['/home', '/calendar'])).toEqual(['/home', '/calendar']);
  });
  it('caps at max', () => {
    expect(sanitizeNavKeys(['/a', '/b', '/c'], undefined, 2)).toEqual(['/a', '/b']);
  });
  it('returns [] for non-arrays', () => {
    expect(sanitizeNavKeys(null)).toEqual([]);
    expect(sanitizeNavKeys('/home')).toEqual([]);
  });
});

describe('resolveNavKeys', () => {
  const defaults = ['/home', '/calendar', '/todos'];
  it('uses the saved layout when valid', () => {
    expect(resolveNavKeys(['/calendar', '/home'], defaults)).toEqual(['/calendar', '/home']);
  });
  it('falls back to defaults when empty/invalid', () => {
    expect(resolveNavKeys([], defaults)).toEqual(defaults);
    expect(resolveNavKeys(null, defaults)).toEqual(defaults);
    expect(resolveNavKeys(['/dashboard/settings'], defaults)).toEqual(defaults); // all stripped → empty → defaults
  });
  it('respects the allowlist on both the saved value and the fallback', () => {
    expect(resolveNavKeys(['/gone'], defaults, ['/home', '/calendar', '/todos'])).toEqual(defaults);
  });
});
