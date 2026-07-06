import { describe, it, expect } from 'vitest';
import {
  normalizeUsername, isValidUsername, suggestUsername, syntheticChildEmail,
} from '@/lib/onboarding/child-login';
import { deriveChildPassword } from '@/lib/onboarding/child-password';

describe('normalizeUsername', () => {
  it('lowercases and strips whitespace', () => {
    expect(normalizeUsername('  Emma Parker ')).toBe('emmaparker');
    expect(normalizeUsername('JJ_2015')).toBe('jj_2015');
  });
});

describe('isValidUsername', () => {
  it('accepts 3–24 char handles', () => {
    expect(isValidUsername('emma')).toBe(true);
    expect(isValidUsername('jj_2015')).toBe(true);
    expect(isValidUsername('a.b-c')).toBe(true);
  });
  it('rejects too short / bad chars / edge punctuation', () => {
    expect(isValidUsername('em')).toBe(false);       // too short
    expect(isValidUsername('_emma')).toBe(false);      // starts with punct
    expect(isValidUsername('emma_')).toBe(false);      // ends with punct
    expect(isValidUsername('emma parker')).toBe(false); // space
    expect(isValidUsername('emma!')).toBe(false);      // bad char
    expect(isValidUsername('a'.repeat(25))).toBe(false); // too long
  });
});

describe('suggestUsername', () => {
  it('derives a handle from a display name', () => {
    expect(suggestUsername('Emma Parker')).toBe('emmaparker');
    expect(suggestUsername('J')).toBe('kiddo'); // too short → fallback
  });
});

describe('syntheticChildEmail', () => {
  it('is deterministic and namespaced', () => {
    expect(syntheticChildEmail('emma')).toBe('child.emma@kids.bubaly.app');
  });
});

describe('deriveChildPassword', () => {
  it('is deterministic for the same inputs', () => {
    expect(deriveChildPassword('secret', 'emma', '1234')).toBe(deriveChildPassword('secret', 'emma', '1234'));
  });
  it('changes with pin, username, or secret', () => {
    const base = deriveChildPassword('secret', 'emma', '1234');
    expect(deriveChildPassword('secret', 'emma', '4321')).not.toBe(base);
    expect(deriveChildPassword('secret', 'liam', '1234')).not.toBe(base);
    expect(deriveChildPassword('other', 'emma', '1234')).not.toBe(base);
  });
  it('returns a 64-char hex string (sha256)', () => {
    expect(deriveChildPassword('s', 'emma', '1234')).toMatch(/^[0-9a-f]{64}$/);
  });
});
