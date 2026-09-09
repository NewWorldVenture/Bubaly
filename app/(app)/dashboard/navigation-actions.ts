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
import { scopeFromUserContext } from '@/lib/services/scope';
import { loadSidebarNavigation, saveSidebarNavigation, type NavigationInput, type SidebarPrefs } from '@/lib/services/navigation';

type Result = { ok: boolean; error?: string; nav?: string[] | null; children?: SidebarPrefs['children'] };

export type { SidebarPrefs } from '@/lib/services/navigation';

/** The signed-in user's saved sidebar layout (raw — client resolves vs its catalog). */
export async function loadSidebarPrefs(): Promise<SidebarPrefs & { error?: string }> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const result = await loadSidebarNavigation(scopeFromUserContext(ctx, supabase));
  return result.ok ? result.data : { nav: null, children: null, error: result.error };
}

/** Persist the member's chosen sidebar layout (merged into notification_prefs).
 *  `children` is optional so top-level-only saves stay lean. */
export async function saveSidebarNavAction(input: NavigationInput): Promise<Result> {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const result = await saveSidebarNavigation(scopeFromUserContext(ctx, supabase), input);
  return result.ok ? { ok: true, ...result.data } : { ok: false, error: result.error };
}
