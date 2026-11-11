import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanText, isValidEmail, isValidPhone } from '@/lib/utils/validation';

// LIBRARY-464F5B6324E1. isValidPhone's own comment lists "(" among the
// separators it accepts, but its pattern required the first character to be
// "+" or a digit, so the ordinary US form "(555) 123-4567" was refused and the
// contact form would not save ("enter a valid phone number"). Nothing tested
// isValidPhone, isValidEmail or cleanText at all.

describe('a phone number in parentheses is a valid phone number', () => {
  it.each([
    ['(555) 123-4567'],
    ['(555)123-4567'],
    ['  (555) 123-4567  '],
    ['(020) 7946 0958'],
    ['(0) 20 7946 0958'],
  ])('%s', (phone) => {
    expect(isValidPhone(phone)).toBe(true);
  });

  it.each([
    ['555-123-4567'],
    ['555.123.4567'],
    ['555 123 4567'],
    ['5551234567'],
    ['+1 (555) 123-4567'],
    ['+15551234567'],
    ['1-555-123-4567'],
    ['+44 20 7946 0958'],
    ['123-4567'],
  ])('the forms that already worked still do: %s', (phone) => {
    expect(isValidPhone(phone)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['(555) 123', 'six digits'],
    ['123456', 'six digits, bare'],
    ['1234567890123456', 'sixteen digits'],
    ['call me', 'words'],
    ['555-CALL-NOW', 'letters among digits'],
    ['(555) 123-4567 ext 9', 'a worded extension'],
    ['-555-123-4567', 'a leading dash'],
    [')555( 123-4567', 'a leading closing parenthesis'],
    ['.5551234567', 'a leading dot'],
    ['5+551234567', 'a plus that is not first'],
    ['(+1) 555 123 4567', 'a plus inside the parentheses'],
    ['mom@example.test', 'an email address'],
  ])('still refused: %s (%s)', (phone) => {
    expect(isValidPhone(phone)).toBe(false);
  });

  it('counts digits, not characters: 7 at least and 15 at most', () => {
    expect(isValidPhone('(12) 34567')).toBe(true);
    expect(isValidPhone('(12) 3456')).toBe(false);
    expect(isValidPhone('(123) 456-789-012-345')).toBe(true);
    expect(isValidPhone('(123) 456-789-012-3456')).toBe(false);
  });

  it('the contact form asks this function about both of its phone fields', () => {
    const form = readFileSync('components/modules/contacts-module.tsx', 'utf8');
    expect(form).toContain('if (payload.phone && !isValidPhone(payload.phone)) return toastError(');
    expect(form).toContain('if (payload.phone_alt && !isValidPhone(payload.phone_alt)) return toastError(');
  });
});

describe('isValidEmail', () => {
  it.each([['mom@example.test'], ['  mom@example.test  '], ['first.last+tag@mail.example.test']])('accepts %s', (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each([[''], ['   '], ['mom'], ['mom@'], ['@example.test'], ['mom@example'], ['mom @example.test'], ['mom@exa mple.test'], ['a@b@c.test']])(
    'refuses %j', (email) => {
      expect(isValidEmail(email)).toBe(false);
    });

  it('refuses an address longer than 254 characters and accepts one of exactly 254', () => {
    const domain = '@example.test';
    expect(isValidEmail('a'.repeat(254 - domain.length) + domain)).toBe(true);
    expect(isValidEmail('a'.repeat(255 - domain.length) + domain)).toBe(false);
  });
});

describe('cleanText', () => {
  it('trims, and answers null for nothing', () => {
    expect(cleanText('  hello  ')).toBe('hello');
    expect(cleanText('')).toBeNull();
    expect(cleanText('   ')).toBeNull();
    expect(cleanText(null)).toBeNull();
    expect(cleanText(undefined)).toBeNull();
  });

  it('cuts to the limit after trimming: 500 by default', () => {
    expect(cleanText(`  ${'x'.repeat(600)}`)).toBe('x'.repeat(500));
    expect(cleanText('  abcdef  ', 3)).toBe('abc');
    expect(cleanText('abc', 3)).toBe('abc');
  });
});
