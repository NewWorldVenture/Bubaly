import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { at } from './helpers/source-order';
import {
  canStoreGoogleToken, decodeGoogleToken, encodeGoogleToken, hasStoredGoogleToken,
} from '@/lib/google-token-storage';

/**
 * Audit C3-S5-02.
 *
 * The Google Calendar token — including the long-lived REFRESH token — was
 * written as a plain JSON object into `user_preferences.notification_prefs`,
 * a row whose policies are `user_id = auth.uid()` for SELECT as well as
 * UPDATE. The user's own browser could read it, so any XSS, any extension,
 * any leaked session, or any future `select('*')` on that table handed over a
 * credential that survives a password change and a session revocation.
 */
const REFRESH = 'REFRESH-TOKEN-1//0gSecret';
const token = { accessToken: 'ACCESS-1', refreshToken: REFRESH, expiresAt: 1_800_000_000_000 };

beforeEach(() => vi.stubEnv('SYNC_TOKEN_KEY', '12'.repeat(32)));

describe('the stored Google token is ciphertext', () => {
  it('round-trips through the envelope', () => {
    const stored = encodeGoogleToken(token);
    expect(decodeGoogleToken(stored)).toEqual({ token, legacy: false });
  });

  it('does not carry the refresh token in the clear', () => {
    const stored = encodeGoogleToken(token);
    // The whole finding in one assertion: what lands in the browser-readable
    // column must not contain the credential.
    expect(stored).not.toContain(REFRESH);
    expect(stored).not.toContain('ACCESS-1');
    expect(stored).not.toContain('refreshToken');
    expect(typeof stored).toBe('string');
  });

  it('refuses a tampered envelope rather than trusting it', () => {
    const stored = encodeGoogleToken(token);
    const [iv, tag, data] = stored.split('.');
    expect(decodeGoogleToken([iv, tag, Buffer.from('{"accessToken":"x"}').toString('base64')].join('.'))).toBeNull();
    expect(decodeGoogleToken('not-an-envelope')).toBeNull();
    expect(decodeGoogleToken(`${data}`)).toBeNull();
  });

  it('reads a legacy plaintext row and marks it for rewriting', () => {
    // Rows written before this fix. There is no SQL migration for them — the
    // key lives in the application — so they convert on first use.
    expect(decodeGoogleToken({ ...token })).toEqual({ token, legacy: true });
    expect(decodeGoogleToken({ accessToken: 'a' })).toEqual({
      token: { accessToken: 'a', refreshToken: null, expiresAt: 0 }, legacy: true,
    });
  });

  it('treats an empty, null or shapeless value as no connection', () => {
    expect(decodeGoogleToken(null)).toBeNull();
    expect(decodeGoogleToken(undefined)).toBeNull();
    expect(decodeGoogleToken('')).toBeNull();
    expect(decodeGoogleToken({})).toBeNull();
    expect(decodeGoogleToken({ accessToken: '' })).toBeNull();
  });

  it('answers "connected" without the key, so a rotation does not disconnect everyone', () => {
    const stored = encodeGoogleToken(token);
    vi.stubEnv('SYNC_TOKEN_KEY', '');
    expect(hasStoredGoogleToken(stored)).toBe(true);
    expect(hasStoredGoogleToken({ accessToken: 'a' })).toBe(true);
    expect(hasStoredGoogleToken(null)).toBe(false);
    expect(canStoreGoogleToken()).toBe(false);
  });
});

describe('both routes go through it', () => {
  const callback = readFileSync('app/api/google/calendar/callback/route.ts', 'utf8');
  const sync = readFileSync('app/api/google/calendar/sync/route.ts', 'utf8');

  it('the callback encrypts before the upsert and never writes the raw token', () => {
    expect(at(callback, 'encodeGoogleToken(token)')).toBeLessThan(at(callback, "from('user_preferences')\n      .upsert("));
    expect(callback).not.toContain('googleCalendarToken: token');
  });

  it('the callback refuses to store anything when there is no key', () => {
    expect(at(callback, 'canStoreGoogleToken()')).toBeLessThan(at(callback, 'encodeGoogleToken(token)'));
  });

  it('the sync route decodes on read and re-encrypts on write', () => {
    expect(sync).toContain('decodeGoogleToken(np.googleCalendarToken)');
    expect(sync).toContain('googleCalendarToken: encodeGoogleToken(refreshedToken)');
    expect(sync).not.toContain('googleCalendarToken: refreshedToken');
  });

  it('a legacy row is rewritten even when the access token did not change', () => {
    // Without `|| decoded.legacy` the plaintext row is read happily forever and
    // nothing ever converts it.
    expect(sync).toContain('|| decoded.legacy');
  });
});
