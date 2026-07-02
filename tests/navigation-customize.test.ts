import { describe, it, expect } from 'vitest';
import {
  sanitizeNavKeys, resolveNavKeys, resolveChildKeys, sanitizeChildMap, FIXED_NAV_ROUTES,
} from '@/lib/navigation/customize';

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

describe('resolveChildKeys', () => {
  const catalog = ['/a', '/b', '/c'];
  it('defaults to the full catalog order when the parent is absent', () => {
    expect(resolveChildKeys({}, '/p', catalog)).toEqual(catalog);
    expect(resolveChildKeys(null, '/p', catalog)).toEqual(catalog);
  });
  it('uses the saved order, filtered to the catalog', () => {
    expect(resolveChildKeys({ '/p': ['/c', '/a', '/x'] }, '/p', catalog)).toEqual(['/c', '/a']);
  });
  it('honors an explicit empty array (parent becomes a plain link)', () => {
    expect(resolveChildKeys({ '/p': [] }, '/p', catalog)).toEqual([]);
  });
});

describe('sanitizeChildMap', () => {
  it('shape-guards without a catalog: object of string arrays', () => {
    expect(sanitizeChildMap({ '/p': ['/a', '/a', 2, '/b'], '': ['/z'] })).toEqual({ '/p': ['/a', '/b'] });
    expect(sanitizeChildMap(['not', 'an', 'object'])).toEqual({});
    expect(sanitizeChildMap(null)).toEqual({});
  });
  it('drops unknown parents and filters children when a validity map is given', () => {
    const valid = new Map<string, readonly string[]>([['/p', ['/a', '/b']]]);
    expect(sanitizeChildMap({ '/p': ['/b', '/nope'], '/other': ['/a'] }, valid)).toEqual({ '/p': ['/b'] });
  });
  it('keeps an explicitly-empty group', () => {
    const valid = new Map<string, readonly string[]>([['/p', ['/a']]]);
    expect(sanitizeChildMap({ '/p': [] }, valid)).toEqual({ '/p': [] });
  });
});
