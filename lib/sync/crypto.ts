// lib/sync/crypto.ts
//
// Symmetric encryption for provider OAuth tokens (and any other secret) before
// they touch the database. We store ONLY ciphertext in sync_tokens; plaintext
// never lands in a column, a log, or the client. AES-256-GCM gives us
// confidentiality + integrity (the auth tag detects tampering).
//
// Key: SYNC_TOKEN_KEY — a 32-byte key, hex (64 chars) or base64. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// SERVER ONLY. Never import this into client code.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length

/**
 * The SHA-256 fallback accepts ANY string, so `SYNC_TOKEN_KEY=changeme` used to
 * produce a perfectly valid AES-256-GCM key with the entropy of the word
 * "changeme" — encrypting fine, decrypting fine, warning nobody. Every defence
 * around sync_tokens (and, since C3-S5-02, the Google Calendar token) assumes
 * this ciphertext is not offline-crackable. A minimum length is a crude
 * proxy for entropy, but it is the difference between a passphrase somebody
 * chose and a placeholder somebody left. Audit C3-S5-06.
 */
const MIN_RAW_KEY_LENGTH = 32;

function keyMaterial(raw: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) return b64;
  if (raw.length < MIN_RAW_KEY_LENGTH) return null;
  return createHash('sha256').update(raw).digest();
}

function loadKey(): Buffer {
  const raw = process.env.SYNC_TOKEN_KEY;
  if (!raw) {
    throw new Error(
      'SYNC_TOKEN_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  const key = keyMaterial(raw);
  if (!key) {
    throw new Error(
      `SYNC_TOKEN_KEY is too short to be a key (${raw.length} characters). Use 64 hex characters or 32 base64-decoded bytes: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return key;
}

/**
 * Encrypts a UTF-8 string. Output format: base64(iv).base64(tag).base64(ciphertext)
 * — a single self-describing token safe to store in a text column.
 */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

/** Reverses encryptSecret. Throws if the key is wrong or the data was tampered with. */
export function decryptSecret(payload: string): string {
  const key = loadKey();
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Malformed encrypted payload');
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Null-tolerant helpers for optional columns (e.g. a missing refresh token). */
export function encryptNullable(plaintext: string | null | undefined): string | null {
  return plaintext == null ? null : encryptSecret(plaintext);
}
export function decryptNullable(payload: string | null | undefined): string | null {
  return payload == null ? null : decryptSecret(payload);
}

/**
 * True when a usable encryption key is configured (for capability/health
 * checks). This used to test PRESENCE, so "we have a key" and "we have a key
 * worth having" were the same question — and the OAuth callbacks that gate on
 * it have a fail-closed path (`error=no_encryption_key`) that a placeholder
 * value walked straight past. Now it answers the second question, and that
 * existing path does the work. Audit C3-S5-06.
 */
export function hasEncryptionKey(): boolean {
  const raw = process.env.SYNC_TOKEN_KEY;
  return !!raw && keyMaterial(raw) !== null;
}
