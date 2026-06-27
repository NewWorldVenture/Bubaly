'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

type Result = { ok: true } | { ok: false; error: string };

/**
 * Persist the user's customized Capture quick-jump buttons (ordered route keys)
 * to user_preferences.ui_prefs so they sync across devices. Merges into the
 * existing ui_prefs bag so other UI prefs are preserved. Resilient: returns a
 * soft error if the column isn't present yet (pre-migration), letting the client
 * keep its localStorage cache rather than throwing.
 */
export async function saveCaptureRoutesAction(keys: string[]): Promise<Result> {
  const ctx = await requireUserContext();
  const userId = ctx.user.id;
  const supabase = await createServer();

  try {
    const clean = keys.filter((k) => typeof k === 'string').slice(0, 24);
    const { data: existing } = await supabase
      .from('user_preferences')
      .select('ui_prefs')
      .eq('user_id', userId)
      .maybeSingle();

    const prev = (existing?.ui_prefs && typeof existing.ui_prefs === 'object' ? existing.ui_prefs : {}) as Record<string, unknown>;
    const ui_prefs = { ...prev, captureQuickRoutes: clean };

    const { error } = await supabase
      .from('user_preferences')
      .upsert({ user_id: userId, ui_prefs }, { onConflict: 'user_id' });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not save' };
  }
}
