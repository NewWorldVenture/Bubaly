'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { updateEvent } from '@/lib/services/calendar';
import { scopeFromUserContext } from '@/lib/services/scope';
import { SERVICE_CODES } from '@/lib/services/types';

/**
 * Apply a conflict resolution by rescheduling one event. Family-scoped: RLS plus
 * an explicit family_id match ensure a user can only move their own family's
 * events. Returns ok/error so the client can show honest feedback.
 *
 * WHY THIS GOES THROUGH THE SERVICE. This used to issue its own
 * `.update({starts_at, ends_at}).eq('id').eq('family_id')` and branch on
 * `error` alone. A PATCH that matches zero rows is not an error in PostgREST —
 * against the repo's own postgrest-js a bare update of a missing row answers
 * `{error: null, status: 204, count: null}` — so the action could not tell a
 * move from a miss, and returned `ok: true` either way. The card then called
 * `onResolved()` (components/family/conflict-resolver.tsx:96), which is client
 * `useState`, so the conflict stayed hidden past the revalidate and the screen
 * could read "All conflicts handled" while the two events still overlapped.
 *
 * Zero rows is the normal outcome of a stale quick fix: the ids come from the
 * page render, and the row can be gone or re-created under a new id (a feed
 * removed and re-added cascades its events away — supabase/migrations/
 * 0045_calendar_feeds.sql), or the active family can have moved in another tab.
 * RLS cannot save this either: a row the policy filters yields zero rows, not an
 * exception.
 *
 * `updateEvent` (lib/services/calendar) is the canonical writer for this table
 * and already asks for the row back with `.select('*').maybeSingle()`, reporting
 * SERVICE_CODES.notFound when nothing came back. Routing through it also gets
 * the conflicts surface the two other things the hand-rolled write skipped: the
 * ends-before-starts check, and the household-trail (audit_logs) row the identical
 * edit from the Calendar page has always recorded. For a member acting through the
 * UI that is the trail row only — recordActivity deliberately writes no
 * agent_activity feed entry for actorKind 'member'.
 */
export async function rescheduleEventAction(
  eventId: string,
  startsAtIso: string,
  endsAtIso: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!eventId || Number.isNaN(new Date(startsAtIso).getTime())) {
    return { ok: false, error: t('actions.invalidRescheduleRequest') };
  }
  const supabase = await createServer();
  const result = await updateEvent(scopeFromUserContext(ctx, supabase), eventId, {
    startsAt: startsAtIso,
    endsAt: endsAtIso,
  });
  if (!result.ok) {
    // The service speaks English; this surface is translated. Only the not-found
    // sentence is re-worded — a db or validation failure keeps the service's own
    // description rather than being flattened into a friendlier untruth.
    return {
      ok: false,
      error: result.code === SERVICE_CODES.notFound ? t('actions.thatEventCouldNotBe') : result.error,
    };
  }
  revalidatePath('/dashboard/conflicts');
  revalidatePath('/dashboard/command-center');
  revalidatePath('/dashboard/calendar');
  return { ok: true };
}
