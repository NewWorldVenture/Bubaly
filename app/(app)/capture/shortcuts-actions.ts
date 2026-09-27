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
import { mergeNotificationPrefs } from '@/lib/preferences/notification-prefs';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: boolean; error?: string };

/**
 * Answer of a shortcut-layout read. THREE outcomes, not two — because the caller
 * composes and writes back the WHOLE visible array, so it must be able to tell
 * "this member has no saved layout" from "we could not find out what their saved
 * layout is". Spelling both `null` collapsed them, and the starter set shown for
 * the second one was then saved over a real layout the read never managed to see.
 *   { ok: true, keys: [...] } → their saved layout.
 *   { ok: true, keys: null }  → read succeeded, nothing saved → never customized.
 *   { ok: false, error }      → the read FAILED. Nothing is known. Do not guess.
 */
export type CaptureShortcutsRead =
  | { ok: true; keys: string[] | null }
  | { ok: false; error: string };

/** The signed-in user's saved capture shortcut keys (raw — client sanitizes vs its catalog). */
export async function loadCaptureShortcuts(): Promise<CaptureShortcutsRead> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // postgrest-js RESOLVES with { data: null, error } instead of throwing, so an
  // unread error here arrives as a perfectly ordinary "no shortcuts saved".
  const { data, error } = await supabase.from('user_preferences')
    .select('notification_prefs').eq('user_id', ctx.user.id).maybeSingle();
  if (error) {
    console.error('[capture/shortcuts] preferences read failed', error);
    return { ok: false, error: describeActionError(error) };
  }
  const prefs = (data?.notification_prefs as Record<string, unknown> | null) ?? null;
  const saved = prefs?.[CAPTURE_SHORTCUTS_PREF_KEY];
  return {
    ok: true,
    keys: Array.isArray(saved) ? (saved as unknown[]).filter((v): v is string => typeof v === 'string') : null,
  };
}

/** Persist the member's chosen shortcut layout (merged into notification_prefs). */
export async function saveCaptureShortcutsAction(input: { keys: string[] }): Promise<Result> {
  const ctx = await requireUserContext();
  // No catalog on the server, so just guard shape: strings, deduped, capped.
  const keys = sanitizeShortcutKeys(input.keys, undefined, MAX_CAPTURE_SHORTCUTS);
  const supabase = await createServer();

  // Only this key changes, merged onto the row as it is at write time and
  // written with a compare-and-set, so an App Lock or Google change made
  // meanwhile is not put back (SRV-001 l7). A read that FAILED is still not an
  // empty blob — nothing is written, since merging into `{}` would erase App
  // Lock, the Google Calendar token and every other key this member has set.
  const saved = await mergeNotificationPrefs(supabase, ctx.user.id,
    (prefs) => ({ ...prefs, [CAPTURE_SHORTCUTS_PREF_KEY]: keys }));
  if (!saved.ok) {
    if (saved.reason === 'read_failed') console.error('[capture/shortcuts] preferences read failed', saved.error);
    else console.error('[capture/shortcuts] preferences write failed', saved.reason, saved.error);
    return { ok: false, error: describeActionError(saved.error) };
  }
  return { ok: true };
}
