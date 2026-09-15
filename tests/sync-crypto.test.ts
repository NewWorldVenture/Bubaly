import { afterEach, describe, expect, it, beforeAll, vi } from 'vitest';
import {
  encryptSecret, decryptSecret, encryptNullable, decryptNullable, hasEncryptionKey,
} from '@/lib/sync/crypto';

beforeAll(() => {
  // 32-byte hex key for deterministic test runs.
  process.env.SYNC_TOKEN_KEY = 'a'.repeat(64);
});

describe('token encryption (AES-256-GCM)', () => {
  it('round-trips a secret', () => {
    const secret = 'ya29.a0AfH6SMC-very-secret-oauth-token';
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('produces different ciphertext each time (random IV)', () => {
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same');
    expect(decryptSecret(b)).toBe('same');
  });

  it('never leaks plaintext into the ciphertext', () => {
    const secret = 'super-secret-value';
    expect(encryptSecret(secret)).not.toContain(secret);
  });

  it('fails closed on tampering (GCM auth tag)', () => {
    const enc = encryptSecret('important');
    const [iv, tag, data] = enc.split('.');
    const tampered = [iv, tag, Buffer.from('zzzz').toString('base64')].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('rejects malformed payloads', () => {
    expect(() => decryptSecret('not-valid')).toThrow();
  });

  it('handles nullable helpers', () => {
    expect(encryptNullable(null)).toBeNull();
    expect(decryptNullable(null)).toBeNull();
    const enc = encryptNullable('x');
    expect(decryptNullable(enc)).toBe('x');
  });

  it('reports key presence', () => {
    expect(hasEncryptionKey()).toBe(true);
  });
});

describe('a placeholder is not a key (C3-S5-06)', () => {
  // beforeAll above sets the process-wide key; stubEnv is undone per test so
  // the rest of the file keeps it.
  afterEach(() => vi.unstubAllEnvs());

  /**
   * The SHA-256 fallback accepted any string, so SYNC_TOKEN_KEY=changeme
   * produced a valid AES key with the entropy of the word "changeme" —
   * encrypting fine, decrypting fine, warning nobody. The OAuth callbacks
   * already had a fail-closed path gated on hasEncryptionKey(); it tested
   * presence, so a placeholder walked past it.
   */
  it('refuses a short value instead of hashing it into a working key', () => {
    vi.stubEnv('SYNC_TOKEN_KEY', 'changeme');
    expect(hasEncryptionKey()).toBe(false);
    expect(() => encryptSecret('x')).toThrow(/too short/);
  });

  it('still accepts the documented forms and a long passphrase', () => {
    vi.stubEnv('SYNC_TOKEN_KEY', 'a'.repeat(64));            // hex
    expect(hasEncryptionKey()).toBe(true);
    vi.stubEnv('SYNC_TOKEN_KEY', Buffer.alloc(32, 7).toString('base64'));
    expect(hasEncryptionKey()).toBe(true);
    vi.stubEnv('SYNC_TOKEN_KEY', 'correct horse battery staple correct');
    expect(hasEncryptionKey()).toBe(true);
    expect(decryptSecret(encryptSecret('round trip'))).toBe('round trip');
  });

  it('an unset key is still unset, not short', () => {
    vi.stubEnv('SYNC_TOKEN_KEY', '');
    expect(hasEncryptionKey()).toBe(false);
    expect(() => encryptSecret('x')).toThrow(/not set/);
  });
});
