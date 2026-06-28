'use server';

// Capture "jump directly to" shortcuts — persisted to Supabase so a member's
// layout follows them across devices (the client also caches to localStorage for
// instant/offline render). Stored as a namespaced key inside the core
// user_preferences.notification_prefs jsonb (no migration needed — same
// read-merge-write pattern the Google Calendar integration already uses there),
// scoped to the signed-in user by that table's own-row RLS.
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { sanitizeShortcutKeys, CAPTURE_SHORTCUTS_PREF_KEY, MAX_CAPTURE_SHORTCUTS } from '@/lib/capture/shortcuts';

type Result = { ok: boolean; error?: string };

/** The signed-in user's saved capture shortcut keys (raw — client sanitizes vs its catalog). */
export async function loadCaptureShortcuts(): Promise<string[] | null> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data } = await supabase.from('user_preferences')
    .select('notification_prefs').eq('user_id', ctx.user.id).maybeSingle();
  const prefs = (data?.notification_prefs as Record<string, unknown> | null) ?? null;
  const saved = prefs?.[CAPTURE_SHORTCUTS_PREF_KEY];
  return Array.isArray(saved) ? (saved as unknown[]).filter((v): v is string => typeof v === 'string') : null;
}

/** Persist the member's chosen shortcut layout (merged into notification_prefs). */
export async function saveCaptureShortcutsAction(input: { keys: string[] }): Promise<Result> {
  const ctx = await requireUserContext();
  // No catalog on the server, so just guard shape: strings, deduped, capped.
  const keys = sanitizeShortcutKeys(input.keys, undefined, MAX_CAPTURE_SHORTCUTS);
  const supabase = await createServer();

  // Read-merge-write so we never clobber other notification_prefs keys.
  const { data: existing } = await supabase.from('user_preferences')
    .select('notification_prefs').eq('user_id', ctx.user.id).maybeSingle();
  const prefs = (existing?.notification_prefs as Record<string, unknown> | null) ?? {};
  const merged = { ...prefs, [CAPTURE_SHORTCUTS_PREF_KEY]: keys };

  const { error } = await supabase.from('user_preferences')
    .upsert({ user_id: ctx.user.id, notification_prefs: merged as never }, { onConflict: 'user_id' });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
