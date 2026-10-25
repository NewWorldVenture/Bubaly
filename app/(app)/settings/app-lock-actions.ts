'use server';

import { cookies } from 'next/headers';
import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { isAppLockConfig, verifyPin, type AppLockConfig } from '@/lib/security/app-lock';
import {
  APP_UNLOCK_COOKIE, appUnlockCookieOptions, isAppUnlocked, sealAppUnlock, storedAppLock,
} from '@/lib/security/app-lock-server';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import type { Json } from '@/lib/database.types';
import { describeActionError } from '@/lib/supabase/errors';
import { mergeNotificationPrefs } from '@/lib/preferences/notification-prefs';

type Result = { ok: true } | { ok: false; error: string };

/** What the lock screen is told. It words each answer itself, in the reader's language. */
export type UnlockResult =
  | { ok: true }
  | { ok: false; reason: 'wrong_pin' | 'unavailable' }
  | { ok: false; reason: 'rate_limited'; retryAfter: number };

// Five tries, then the keypad waits out the window. It used to be five tries
// and a 30-second cooldown held in React state, which a reload reset. This one
// is the durable limiter (rate_limit_hit), so neither a reload nor another
// browser nor another server instance starts the count again.
const UNLOCK_ATTEMPTS = 5;
const UNLOCK_WINDOW_MS = 5 * 60_000;

function actionFailure(operation: string, message: string, error: unknown): Result {
  console.error(`[app-lock-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

/**
 * Persists (or clears) the App Lock config in user_preferences.notification_prefs.
 * The PIN is already salted + hashed on the client — only { enabled, salt, hash }
 * is sent here; the plaintext PIN never reaches the server. Passing null disables
 * and removes the lock entirely. Stored per-user (the lock is personal).
 *
 * A browser the lock is holding — the stored lock is on and this request has no
 * unlock for its PIN — is refused. Otherwise this endpoint would be the way
 * round the lock screen: one POST to turn the lock off, or to set a PIN the
 * holder knows.
 *
 * On success this browser keeps its place: a lock turned on, or a PIN changed,
 * comes with a fresh unlock for the new PIN (this device was already in the
 * app), and a lock turned off or removed drops the unlock. Every OTHER browser
 * that unlocked with an old PIN is locked again, because its cookie names the
 * old salt and hash (lib/security/app-lock-server.ts).
 */
export async function saveAppLockConfig(config: AppLockConfig | null): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  if (config !== null && !isAppLockConfig(config)) {
    return { ok: false, error: t('appLockActions.invalidLockConfiguration') };
  }

  const jar = await cookies();
  const current = await supabase.from('user_preferences')
    .select('notification_prefs').eq('user_id', ctx.user.id).maybeSingle();
  if (current.error) {
    return actionFailure('load App Lock settings', t('appLockActions.couldNotLoadAppLockSettings'), current.error);
  }
  const stored = storedAppLock(current.data?.notification_prefs);
  if (stored?.enabled && !isAppUnlocked(ctx.user.id, stored, jar.get(APP_UNLOCK_COOKIE)?.value)) {
    console.error('[app-lock-action] refused a settings change from a locked browser', { userId: ctx.user.id });
    return { ok: false, error: t('appLockActions.couldNotSaveAppLockSettings') };
  }

  // Only `appLock` changes, merged onto the row as it is at write time and
  // written with a compare-and-set (SRV-001 l7). A whole-blob write here could
  // be put back by a shortcut save or a Google sync that had read the row
  // first: the card said "App Lock is on" and the old config came back.
  const saved = await mergeNotificationPrefs(supabase, ctx.user.id, (prefs) => {
    const next = { ...prefs };
    if (config === null) delete next.appLock;
    else next.appLock = config as unknown as Json;
    return next;
  });
  if (!saved.ok) {
    return saved.reason === 'read_failed'
      ? actionFailure('load App Lock settings', t('appLockActions.couldNotLoadAppLockSettings'), saved.error)
      : actionFailure('save App Lock settings', t('appLockActions.couldNotSaveAppLockSettings'), saved.error ?? saved.reason);
  }

  const unlock = config?.enabled ? sealAppUnlock(ctx.user.id, config) : null;
  if (unlock) jar.set(APP_UNLOCK_COOKIE, unlock, appUnlockCookieOptions());
  else jar.delete({ name: APP_UNLOCK_COOKIE, ...appUnlockCookieOptions() });
  return { ok: true };
}

/**
 * The lock screen's PIN check, on the server. The PIN arrives here, is hashed
 * against the caller's OWN stored salt (read on their session), and is never
 * stored or logged. Every attempt — right or wrong — spends one of the
 * caller's durable tries first, keyed on their id. A right PIN earns the
 * session-scoped unlock cookie; the client then refreshes, and the layout
 * renders the app.
 */
export async function unlockAppAction(pin: string): Promise<UnlockResult> {
  const supabase = await createServer();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  const user = auth?.user;
  if (authError || !user) return { ok: false, reason: 'unavailable' };

  const limited = await enforceRequestRateLimit(supabase, `app-lock:unlock:${user.id}`, {
    limit: UNLOCK_ATTEMPTS, windowMs: UNLOCK_WINDOW_MS,
  });
  if (!limited.ok) return { ok: false, reason: 'rate_limited', retryAfter: Math.max(1, limited.retryAfter) };

  const { data: prefs, error } = await supabase.from('user_preferences')
    .select('notification_prefs').eq('user_id', user.id).maybeSingle();
  if (error) {
    console.error('[app-lock-action] unlock could not read the lock', { userId: user.id, error: error.message });
    return { ok: false, reason: 'unavailable' };
  }
  const lock = storedAppLock(prefs?.notification_prefs);
  // No lock on: there is nothing to unlock, and the layout already renders the app.
  if (!lock?.enabled) return { ok: true };

  if (typeof pin !== 'string' || !(await verifyPin(pin, lock))) return { ok: false, reason: 'wrong_pin' };

  const unlock = sealAppUnlock(user.id, lock);
  if (!unlock) return { ok: false, reason: 'unavailable' };
  (await cookies()).set(APP_UNLOCK_COOKIE, unlock, appUnlockCookieOptions());
  return { ok: true };
}

/** "Lock now": drop this browser's unlock, so the next render is the lock screen. */
export async function lockAppAction(): Promise<{ ok: true }> {
  await requireUserContext();
  (await cookies()).delete({ name: APP_UNLOCK_COOKIE, ...appUnlockCookieOptions() });
  return { ok: true };
}
