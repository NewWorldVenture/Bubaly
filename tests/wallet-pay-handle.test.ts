import { describe, it, expect } from 'vitest';
import {
  normalizeHandle, isValidHandle, handleError, payHandleUrl,
  RESERVED_HANDLES, HANDLE_MIN, HANDLE_MAX,
} from '@/lib/wallet/pay-handle';

describe('normalizeHandle', () => {
  it('lowercases, trims, strips leading @, and removes invalid chars', () => {
    expect(normalizeHandle('  @Mia ')).toBe('mia');
    expect(normalizeHandle('Mia.Rose!')).toBe('miarose');
    expect(normalizeHandle('cool_kid_7')).toBe('cool_kid_7');
    expect(normalizeHandle('@@@bob')).toBe('bob');
    expect(normalizeHandle(null)).toBe('');
  });
});

describe('handleError / isValidHandle', () => {
  it('accepts a clean handle', () => {
    expect(handleError('mia')).toBeNull();
    expect(isValidHandle('cool_kid_7')).toBe(true);
  });
  it('rejects too-short handles', () => {
    expect(handleError('ab')).toMatch(new RegExp(`${HANDLE_MIN}`));
    expect(isValidHandle('ab')).toBe(false);
  });
  it('rejects too-long handles', () => {
    expect(handleError('a'.repeat(HANDLE_MAX + 1))).toMatch(new RegExp(`${HANDLE_MAX}`));
  });
  it('rejects reserved handles', () => {
    expect(handleError('admin')).toMatch(/reserved/i);
    expect(handleError('@Bubaly')).toMatch(/reserved/i);
    expect(isValidHandle('pay')).toBe(false);
    expect(RESERVED_HANDLES.has('wallet')).toBe(true);
  });
  it('normalizes before validating (uppercase/@ are fine)', () => {
    expect(isValidHandle('@MiaRose')).toBe(true);
  });
  it('rejects when normalization empties it', () => {
    expect(isValidHandle('!!!')).toBe(false);
  });
});

describe('payHandleUrl', () => {
  it('builds the public URL without a double slash', () => {
    expect(payHandleUrl('https://www.bubaly.com', 'mia')).toBe('https://www.bubaly.com/pay/mia');
    expect(payHandleUrl('https://www.bubaly.com/', 'mia')).toBe('https://www.bubaly.com/pay/mia');
  });
});
