'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { isAppLockConfig, type AppLockConfig } from '@/lib/security/app-lock';
import type { Json } from '@/lib/database.types';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: true } | { ok: false; error: string };

function actionFailure(operation: string, error: unknown): Result {
  console.error(`[app-lock-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, `Could not ${operation}.`) };
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

  const { data: prefs, error: prefsError } = await supabase
    .from('user_preferences')
    .select('notification_prefs')
    .eq('user_id', ctx.user.id)
    .maybeSingle();
  if (prefsError) return actionFailure('load App Lock settings', prefsError);

  const np = ((prefs?.notification_prefs as Record<string, unknown> | null) ?? {});
  const next = { ...np };
  if (config === null) delete next.appLock;
  else next.appLock = config;

  const { error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: ctx.user.id, notification_prefs: next as Json }, { onConflict: 'user_id' });

  if (error) return actionFailure('save App Lock settings', error);
  return { ok: true };
}
