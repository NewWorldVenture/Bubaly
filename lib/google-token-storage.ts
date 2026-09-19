import 'server-only';
import { encryptSecret, decryptSecret, hasEncryptionKey } from '@/lib/sync/crypto';
import type { GoogleToken } from '@/lib/google';

/**
 * How the Google Calendar token is stored.
 *
 * It used to be written as a plain JSON object inside
 * `user_preferences.notification_prefs`, and that row's own policies are
 * `user_id = auth.uid()` for SELECT *and* UPDATE — so the browser holding the
 * user's session could read the Google **refresh** token in the clear. A
 * refresh token outlives a password change and a session revocation, and this
 * app asks for `access_type=offline`, so it reads the user's calendar until
 * they revoke it at accounts.google.com, which nothing here tells them to do.
 *
 * Twenty files away the repository already did this properly: `lib/sync/`
 * AES-256-GCM-encrypts provider tokens into `sync_tokens`, a table locked to
 * `using (false)`. Two Google-calendar integrations had opposite answers to
 * "where does a refresh token live". This gives the older one the newer one's
 * answer, using the same key and the same primitives rather than a second
 * implementation of them.
 *
 * Audit C3-S5-02.
 */

/** The envelope shape written from now on: a single opaque string. */
export function encodeGoogleToken(token: GoogleToken): string {
  return encryptSecret(JSON.stringify(token));
}

export type StoredGoogleToken = { token: GoogleToken; legacy: boolean };

/**
 * Reads either form. `legacy: true` means the value was found as plaintext, so
 * the caller should rewrite it encrypted — there is no migration that can do
 * this in SQL, because the key lives in the application, so the rows convert as
 * they are used.
 */
export function decodeGoogleToken(value: unknown): StoredGoogleToken | null {
  if (typeof value === 'string') {
    if (!value) return null;
    try {
      const parsed = JSON.parse(decryptSecret(value)) as GoogleToken;
      return typeof parsed?.accessToken === 'string' ? { token: parsed, legacy: false } : null;
    } catch {
      // A wrong key or a tampered payload. Returning null puts the "Connect
      // Google" button back, which is recoverable; guessing is not.
      return null;
    }
  }
  if (value && typeof value === 'object') {
    const legacy = value as Partial<GoogleToken>;
    if (typeof legacy.accessToken !== 'string' || !legacy.accessToken) return null;
    return {
      token: {
        accessToken: legacy.accessToken,
        refreshToken: typeof legacy.refreshToken === 'string' ? legacy.refreshToken : null,
        expiresAt: typeof legacy.expiresAt === 'number' ? legacy.expiresAt : 0,
      },
      legacy: true,
    };
  }
  return null;
}

/**
 * Is a connection stored at all? Answered WITHOUT decrypting, so the status
 * endpoint does not need the key and a key rotation does not make every user
 * look disconnected.
 */
export function hasStoredGoogleToken(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  return !!(value && typeof value === 'object' && (value as Partial<GoogleToken>).accessToken);
}

/** True when the token can be stored the way this module requires. */
export function canStoreGoogleToken(): boolean {
  return hasEncryptionKey();
}
