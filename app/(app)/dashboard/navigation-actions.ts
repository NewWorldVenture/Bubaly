'use server';

// Customizable Free-tier sidebar layout — persisted to Supabase so a member's
// chosen destinations follow them across devices (the client also caches to
// localStorage for instant/offline render). Both the top-level order AND each
// expandable group's sub-page order live as namespaced keys inside the core
// user_preferences.notification_prefs jsonb (no migration needed — same
// read-merge-write pattern the Capture shortcuts + Google Calendar integration
// already use there), scoped to the signed-in user by that table's own-row RLS.
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import {
  sanitizeNavKeys, sanitizeChildMap, MAX_SIDEBAR_NAV,
  SIDEBAR_NAV_PREF_KEY, SIDEBAR_NAV_CHILDREN_PREF_KEY, type NavChildMap,
} from '@/lib/navigation/customize';

type Result = { ok: boolean; error?: string };

export type SidebarPrefs = { nav: string[] | null; children: NavChildMap | null };

/** The signed-in user's saved sidebar layout (raw — client resolves vs its catalog). */
export async function loadSidebarPrefs(): Promise<SidebarPrefs> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data } = await supabase.from('user_preferences')
    .select('notification_prefs').eq('user_id', ctx.user.id).maybeSingle();
  const prefs = (data?.notification_prefs as Record<string, unknown> | null) ?? null;

  const rawNav = prefs?.[SIDEBAR_NAV_PREF_KEY];
  const nav = Array.isArray(rawNav)
    ? (rawNav as unknown[]).filter((v): v is string => typeof v === 'string')
    : null;

  const rawChildren = prefs?.[SIDEBAR_NAV_CHILDREN_PREF_KEY];
  const children = rawChildren && typeof rawChildren === 'object' && !Array.isArray(rawChildren)
    ? sanitizeChildMap(rawChildren)
    : null;

  return { nav, children };
}

/** Persist the member's chosen sidebar layout (merged into notification_prefs).
 *  `children` is optional so top-level-only saves stay lean. */
export async function saveSidebarNavAction(input: { keys: string[]; children?: NavChildMap }): Promise<Result> {
  const ctx = await requireUserContext();
  // No catalog on the server, so just guard shape: strings, deduped, chrome
  // routes stripped, capped. The client validates against the real catalog.
  const keys = sanitizeNavKeys(input.keys, undefined, MAX_SIDEBAR_NAV);
  const supabase = await createServer();

  // Read-merge-write so we never clobber other notification_prefs keys.
  const { data: existing } = await supabase.from('user_preferences')
    .select('notification_prefs').eq('user_id', ctx.user.id).maybeSingle();
  const prefs = (existing?.notification_prefs as Record<string, unknown> | null) ?? {};
  const merged: Record<string, unknown> = { ...prefs, [SIDEBAR_NAV_PREF_KEY]: keys };
  if (input.children !== undefined) {
    merged[SIDEBAR_NAV_CHILDREN_PREF_KEY] = sanitizeChildMap(input.children);
  }

  const { error } = await supabase.from('user_preferences')
    .upsert({ user_id: ctx.user.id, notification_prefs: merged as never }, { onConflict: 'user_id' });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
