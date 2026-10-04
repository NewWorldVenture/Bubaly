'use server';

import { createServer } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';

export type EmailPreferenceResult =
  | { ok: true; userId: string; enabled: boolean }
  | { ok: false; error: string };

/** Personal preferences use the request's RLS client, never a client-supplied owner. */
export async function getEmailPreferenceAction(): Promise<EmailPreferenceResult> {
  const t = await getTranslations();
  try {
    const db = await createServer();
    const auth = await db.auth.getUser();
    if (auth.error) return { ok: false, error: t('ai.accountContextIsTemporarilyUnavailable') };
    const userId = auth.data.user?.id;
    if (!userId) return { ok: false, error: t('actions.notSignedIn') };

    const read = await db.from('user_preferences').select('user_id, email_enabled').eq('user_id', userId).limit(1);
    // Only an actual empty list means the row has not been created yet.
    if (read.error || !Array.isArray(read.data) || read.data.length > 1) {
      return { ok: false, error: t('assistantModule.somethingWentWrong') };
    }
    if (read.data.length === 0) return { ok: true, userId, enabled: true };
    const row = read.data[0];
    if (row.user_id !== userId || typeof row.email_enabled !== 'boolean') {
      return { ok: false, error: t('assistantModule.somethingWentWrong') };
    }
    return { ok: true, userId, enabled: row.email_enabled };
  } catch {
    return { ok: false, error: t('assistantModule.somethingWentWrong') };
  }
}

export async function setEmailPreferenceAction(enabled: boolean): Promise<EmailPreferenceResult> {
  const t = await getTranslations();
  if (typeof enabled !== 'boolean') return { ok: false, error: t('aiActions.couldNotSaveThoseSettings') };
  try {
    const db = await createServer();
    const auth = await db.auth.getUser();
    if (auth.error) return { ok: false, error: t('ai.accountContextIsTemporarilyUnavailable') };
    const userId = auth.data.user?.id;
    if (!userId) return { ok: false, error: t('actions.notSignedIn') };

    // Updating this one column must not replace the shared notification_prefs
    // JSON or any other account preference. Upsert also handles an absent row.
    const saved = await db.from('user_preferences')
      .upsert({ user_id: userId, email_enabled: enabled }, { onConflict: 'user_id' })
      .select('user_id, email_enabled');
    if (saved.error) return { ok: false, error: t('aiActions.couldNotSaveThoseSettings') };
    if (!Array.isArray(saved.data) || saved.data.length !== 1 || saved.data[0].user_id !== userId
      || saved.data[0].email_enabled !== enabled) {
      return { ok: false, error: t('errors.thatChangeWasNotSaved') };
    }
    return { ok: true, userId, enabled };
  } catch {
    return { ok: false, error: t('aiActions.couldNotSaveThoseSettings') };
  }
}
