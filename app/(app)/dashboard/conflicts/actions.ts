'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { updateEvent } from '@/lib/services/calendar';
import { scopeFromUserContext } from '@/lib/services/scope';
import { SERVICE_CODES } from '@/lib/services/types';
import { describeActionError } from '@/lib/supabase/errors';
import { compareExactInstants } from '@/lib/calendar/exact-instant';
import { isSeries } from '@/lib/calendar/occurrences';

/** The times the quick fix was computed from, as the page rendered them. */
export type RenderedEventTimes = { startsAt: string; endsAt: string | null; allDay: boolean };

const sameInstant = (a: string | null, b: string | null): boolean => {
  if (a === null || b === null) return a === b;
  try { return compareExactInstants(a, b) === 0; } catch { return false; }
};

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
 *
 * Two more ways the one-tap move rewrote the wrong thing (N11):
 *
 * - A recurring event is ONE row whose `starts_at` is its first occurrence
 *   (lib/calendar/occurrences.ts). Moving "this" practice wrote the series
 *   row, so every future week moved with it, and the schema has no
 *   single-occurrence exception to write instead. A series is refused here and
 *   offered no quick fix on the page; it is changed on the calendar.
 * - The new times were computed when the page rendered. `updateEvent` re-read
 *   the row and compared-and-set against THAT, so a reschedule another member
 *   made after the render was silently undone. The rendered times now travel
 *   with the fix, and the write is refused unless the row still has them.
 */
export async function rescheduleEventAction(
  eventId: string,
  startsAtIso: string,
  endsAtIso: string | null,
  rendered?: RenderedEventTimes,
): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!eventId || Number.isNaN(new Date(startsAtIso).getTime())) {
    return { ok: false, error: t('actions.invalidRescheduleRequest') };
  }
  const supabase = await createServer();
  const { data: current, error: readError } = await supabase.from('calendar_events')
    .select('id, title, starts_at, ends_at, all_day, recurrence')
    .eq('id', eventId).eq('family_id', ctx.active.familyId).maybeSingle();
  if (readError) return { ok: false, error: describeActionError(readError, t('conflictResolver.couldNotReschedule')) };
  if (!current) return { ok: false, error: t('actions.thatEventCouldNotBe') };
  if (isSeries(current)) return { ok: false, error: t('actions.thatEventRepeatsMoveItOnThe') };
  if (rendered && (!sameInstant(current.starts_at, rendered.startsAt)
    || !sameInstant(current.ends_at, rendered.endsAt) || current.all_day !== rendered.allDay)) {
    return { ok: false, error: t('actions.thatEventChangedSinceThisPage') };
  }
  const result = await updateEvent(scopeFromUserContext(ctx, supabase), eventId, {
    startsAt: startsAtIso,
    endsAt: endsAtIso,
  }, current);
  if (!result.ok) {
    // The service speaks English; this surface is translated. Only the not-found
    // sentence is re-worded — a db or validation failure keeps the service's own
    // description rather than being flattened into a friendlier untruth.
    return {
      ok: false,
      error: result.code === SERVICE_CODES.notFound ? t('actions.thatEventCouldNotBe') : result.error,
    };
  }
  // A Smart Departure planned for this event has moved with it: updateEvent
  // follows every move it writes (lib/trips/follow-event.ts).
  revalidatePath('/dashboard/conflicts');
  revalidatePath('/dashboard/command-center');
  revalidatePath('/dashboard/calendar');
  return { ok: true };
}
