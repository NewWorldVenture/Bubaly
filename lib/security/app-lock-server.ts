import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAppLockConfig, type AppLockConfig } from '@/lib/security/app-lock';

// The server half of App Lock: the proof that THIS browser entered the PIN.
//
// The lock used to be decided in the browser. The (app) layout handed the
// client gate the PIN's `salt` and `hash`, so both sat in the RSC payload for
// anyone holding the device to read and brute-force offline (10,000 PINs is
// nothing), the attempt limit was React state that a reload reset, and the
// page itself was rendered into the payload underneath the overlay.
//
// Now the PIN is checked by `unlockAppAction` on the server, and a correct one
// earns this cookie. The layout renders the app only when the request carries a
// valid one for the signed-in user; otherwise it renders the lock screen alone,
// with no app content and no salt or hash.
//
// The value is `<userId>.<mac>`, the MAC an HMAC-SHA256 over the user id and
// the stored PIN's salt and hash, keyed on a server secret the browser never
// sees. So it:
//   - cannot be forged, though the salt and hash are not secret from the user;
//   - unlocks only the user it names — another account signing in on this
//     browser meets its own lock;
//   - stops unlocking the moment the PIN changes (a new PIN has a new salt and
//     hash), on every device that unlocked with the old one.
// Turning the lock off and on again keeps the same PIN, so a browser that
// unlocked with it earlier in its session stays unlocked: it has already
// shown that it knows the PIN.
//
// SESSION-scoped, deliberately: no Max-Age or Expires, so the browser drops it
// when it closes. That is a change from the sessionStorage flag it replaces,
// which was per TAB: one unlock now covers every tab of the browser until the
// browser closes (or "Lock now", which deletes it).

export const APP_UNLOCK_COOKIE = 'bubaly_app_unlock';

// The same secrets, in the same order, that already key the rate-limit subject
// digest (lib/server/rate-limit-db.ts): both are present in every deployment
// that can talk to its database. With neither in production nothing is
// minted and nothing verifies — the lock stays shut, which is the direction a
// lock the user chose must fail. Development and tests, where no production
// secret exists, use the constant so the lock still works there.
const DEV_KEY = 'bubaly-dev-app-lock-unlock';
const DOMAIN = 'bubaly-app-lock-unlock\0v1\0';
const USER_ID = /^[0-9A-Za-z-]{1,64}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;

function signingKey(): string | null {
  const configured = [process.env.INTERNAL_SECRET, process.env.SUPABASE_SERVICE_ROLE_KEY]
    .find((value) => typeof value === 'string' && value.trim() !== '');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    console.error('[app-lock] no INTERNAL_SECRET or SUPABASE_SERVICE_ROLE_KEY: App Lock cannot issue or accept an unlock');
    return null;
  }
  return DEV_KEY;
}

function mac(key: string, userId: string, cfg: Pick<AppLockConfig, 'salt' | 'hash'>): Buffer {
  return createHmac('sha256', key).update(DOMAIN).update(userId).update('\0')
    .update(cfg.salt).update('\0').update(cfg.hash).digest();
}

/** The stored App Lock config in a `notification_prefs` blob, or null. */
export function storedAppLock(prefs: unknown): AppLockConfig | null {
  const raw = prefs && typeof prefs === 'object' ? (prefs as Record<string, unknown>).appLock : null;
  return isAppLockConfig(raw) ? raw : null;
}

/** The cookie value that unlocks `userId` while `cfg` is their PIN; null when no key is configured. */
export function sealAppUnlock(userId: string, cfg: Pick<AppLockConfig, 'salt' | 'hash'>): string | null {
  const key = signingKey();
  if (!key || !USER_ID.test(userId)) return null;
  return `${userId}.${mac(key, userId, cfg).toString('base64url')}`;
}

/** True when `value` is an unlock this server issued, for this user and this PIN. */
export function isAppUnlocked(userId: string, cfg: Pick<AppLockConfig, 'salt' | 'hash'>, value: string | undefined | null): boolean {
  if (typeof value !== 'string' || value.length > 200) return false;
  const [id, signature, ...rest] = value.split('.');
  if (rest.length || id !== userId || !signature || !MAC.test(signature)) return false;
  const key = signingKey();
  if (!key) return false;
  const presented = Buffer.from(signature, 'base64url');
  const expected = mac(key, userId, cfg);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** httpOnly, SameSite=Lax, Secure in production, and no Max-Age: it ends with the browser session. */
export function appUnlockCookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' };
}
