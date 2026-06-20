import { describe, expect, it, beforeAll } from 'vitest';
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
