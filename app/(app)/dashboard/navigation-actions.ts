'use server';

// Customizable Free-tier sidebar layout — persisted to Supabase so a member's
// chosen primary destinations follow them across devices (the client also caches
// to localStorage for instant/offline render). Stored as a namespaced key inside
// the core user_preferences.notification_prefs jsonb (no migration needed — same
// read-merge-write pattern the Capture shortcuts + Google Calendar integration
// already use there), scoped to the signed-in user by that table's own-row RLS.
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { sanitizeNavKeys, SIDEBAR_NAV_PREF_KEY, MAX_SIDEBAR_NAV } from '@/lib/navigation/customize';

type Result = { ok: boolean; error?: string };

/** The signed-in user's saved sidebar layout (raw hrefs — client resolves vs its catalog). */
export async function loadSidebarNav(): Promise<string[] | null> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data } = await supabase.from('user_preferences')
    .select('notification_prefs').eq('user_id', ctx.user.id).maybeSingle();
  const prefs = (data?.notification_prefs as Record<string, unknown> | null) ?? null;
  const saved = prefs?.[SIDEBAR_NAV_PREF_KEY];
  return Array.isArray(saved) ? (saved as unknown[]).filter((v): v is string => typeof v === 'string') : null;
}

/** Persist the member's chosen sidebar layout (merged into notification_prefs). */
export async function saveSidebarNavAction(input: { keys: string[] }): Promise<Result> {
  const ctx = await requireUserContext();
  // No catalog on the server, so just guard shape: strings, deduped, chrome
  // routes stripped, capped. The client validates against the real catalog.
  const keys = sanitizeNavKeys(input.keys, undefined, MAX_SIDEBAR_NAV);
  const supabase = await createServer();

  // Read-merge-write so we never clobber other notification_prefs keys.
  const { data: existing } = await supabase.from('user_preferences')
    .select('notification_prefs').eq('user_id', ctx.user.id).maybeSingle();
  const prefs = (existing?.notification_prefs as Record<string, unknown> | null) ?? {};
  const merged = { ...prefs, [SIDEBAR_NAV_PREF_KEY]: keys };

  const { error } = await supabase.from('user_preferences')
    .upsert({ user_id: ctx.user.id, notification_prefs: merged as never }, { onConflict: 'user_id' });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
