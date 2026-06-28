import { describe, it, expect } from 'vitest';
import { isValidPin, hashPin, verifyPin, buildAppLockConfig, isAppLockConfig, randomSalt } from '@/lib/security/app-lock';

describe('isValidPin', () => {
  it('accepts exactly 4 digits', () => {
    expect(isValidPin('0000')).toBe(true);
    expect(isValidPin('1234')).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('12345')).toBe(false);
    expect(isValidPin('12a4')).toBe(false);
    expect(isValidPin('')).toBe(false);
  });
});

describe('hashPin / verifyPin', () => {
  it('is deterministic for a given pin+salt', async () => {
    const h1 = await hashPin('1234', 'abcd');
    const h2 = await hashPin('1234', 'abcd');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });
  it('differs by salt and by pin', async () => {
    expect(await hashPin('1234', 'aaaa')).not.toBe(await hashPin('1234', 'bbbb'));
    expect(await hashPin('1234', 'aaaa')).not.toBe(await hashPin('9999', 'aaaa'));
  });
  it('verifyPin matches only the correct pin', async () => {
    const cfg = await buildAppLockConfig('4071');
    expect(await verifyPin('4071', cfg)).toBe(true);
    expect(await verifyPin('0000', cfg)).toBe(false);
    expect(await verifyPin('407', cfg)).toBe(false);   // invalid shape
  });
});

describe('buildAppLockConfig', () => {
  it('produces an enabled config with a random salt', async () => {
    const a = await buildAppLockConfig('1234');
    const b = await buildAppLockConfig('1234');
    expect(a.enabled).toBe(true);
    expect(isAppLockConfig(a)).toBe(true);
    expect(a.salt).not.toBe(b.salt);   // fresh salt each time
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('isAppLockConfig / randomSalt', () => {
  it('validates shape', () => {
    expect(isAppLockConfig({ enabled: true, salt: 'x', hash: 'y' })).toBe(true);
    expect(isAppLockConfig({ enabled: true })).toBe(false);
    expect(isAppLockConfig(null)).toBe(false);
  });
  it('randomSalt is 32 hex chars (16 bytes)', () => {
    expect(randomSalt()).toMatch(/^[0-9a-f]{32}$/);
  });
});
