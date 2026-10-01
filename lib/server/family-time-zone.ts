// lib/server/family-time-zone.ts — the active family's zone, for the layout that
// hands it to every client component below it (TIME-003).
//
// The (app) layout is above every family surface, including the ones with no
// AppFrame (the kids view, the kitchen display, settings), so it is where the
// zone has to enter the locale context. It already holds the signed-in user;
// this adds the two reads `getUserContext` would make to pick the active family,
// and nothing else, rather than resolving the whole user context a second time
// on every authenticated request.
//
// TOTAL, and fails to "no zone" rather than to a wrong one. A failed read leaves
// client components on the reader's zone — exactly what they did before this
// existed — and framed routes still get the authoritative zone from
// `AppProvider`, which is handed `ctx.active.family` itself. Taking a page down
// because a formatter could not learn its zone would be the worse error.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { chooseActiveMembership } from '@/lib/auth/active-membership';
import { isValidTimezone } from '@/lib/time/zoned';

type ZoneEmbed = { timezone?: string | null } | { timezone?: string | null }[] | null | undefined;

// Match the 1.5 s budget for optional layout data in social-links and SEO.
// Formatting enrichment must not hold the authenticated shell through retries.
const FAMILY_TIME_ZONE_TIMEOUT_MS = 1_500;

export async function activeFamilyTimeZone(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<string | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
      controller.abort();
    }, FAMILY_TIME_ZONE_TIMEOUT_MS);
  });
  try {
    // Start the deadline before the SDK can wait for an access token. Abort
    // alone cannot release that wait or a transport that ignores its signal.
    return await Promise.race([
      readActiveFamilyTimeZone(supabase, userId, controller.signal),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function readActiveFamilyTimeZone(
  supabase: SupabaseClient<Database>,
  userId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const [{ data: rows, error }, { data: prefs, error: prefsError }] = await Promise.all([
      supabase
        .from('family_members')
        .select('family_id, created_at, families(timezone)')
        .eq('user_id', userId)
        .eq('is_active', true)
        .abortSignal(signal),
      supabase
        .from('user_preferences')
        .select('active_family_id')
        .eq('user_id', userId)
        .abortSignal(signal)
        .maybeSingle(),
    ]);
    if (signal.aborted) return undefined;
    if (error) {
      console.warn('[family-time-zone] membership read failed; client clocks keep the reader\'s zone', error.message);
      return undefined;
    }
    if (prefsError) console.warn('[family-time-zone] preference read failed; using the earliest membership', prefsError.message);
    const active = chooseActiveMembership(rows ?? [], prefs?.active_family_id);
    const family = active?.families as ZoneEmbed;
    const zone = Array.isArray(family) ? family[0]?.timezone : family?.timezone;
    return zone && isValidTimezone(zone) ? zone : undefined;
  } catch (cause) {
    if (signal.aborted) return undefined;
    console.warn('[family-time-zone] zone read threw; client clocks keep the reader\'s zone', cause);
    return undefined;
  }
}
