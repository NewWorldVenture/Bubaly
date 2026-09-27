'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { isAppLockConfig, type AppLockConfig } from '@/lib/security/app-lock';
import type { Json } from '@/lib/database.types';
import { describeActionError } from '@/lib/supabase/errors';
import { mergeNotificationPrefs } from '@/lib/preferences/notification-prefs';

type Result = { ok: true } | { ok: false; error: string };

function actionFailure(operation: string, message: string, error: unknown): Result {
  console.error(`[app-lock-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

/**
 * Persists (or clears) the App Lock config in user_preferences.notification_prefs.
 * The PIN is already salted + hashed on the client — only { enabled, salt, hash }
 * is sent here; the plaintext PIN never reaches the server. Passing null disables
 * and removes the lock entirely. Stored per-user (the lock is personal).
 */
export async function saveAppLockConfig(config: AppLockConfig | null): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  if (config !== null && !isAppLockConfig(config)) {
    return { ok: false, error: t('appLockActions.invalidLockConfiguration') };
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
  return { ok: true };
}
