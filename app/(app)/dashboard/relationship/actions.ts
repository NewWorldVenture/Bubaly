// Putting an anniversary on the family calendar, and taking it off again.
//
// Both halves in one action, because the pair has to stay consistent and the
// client could not make it so. `toggleCalendar` used to:
//
//   await sb.from('calendar_events').delete().eq('id', d.calendar_event_id);
//   // ...and then clear calendar_event_id regardless
//
// with the delete's result DISCARDED. A failed delete still cleared the link, so
// the date said "not on your calendar" while the event sat there — and nothing
// on either side knew about the other any more. Doing both here means the link
// is only cleared once the event is actually gone.
//
// The write itself goes through `lib/services/calendar`, family-scoped, where the
// client filtered `id` alone on the delete and sent its own `family_id` on the
// insert.
'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { createEvent, deleteEvent } from '@/lib/services/calendar';
import { buildCalendarEventForDate } from '@/lib/relationship/calendar';
import { scopeFromUserContext } from '@/lib/services/scope';
import { SERVICE_CODES } from '@/lib/services/types';
import { describeActionError } from '@/lib/supabase/errors';
import type { EventCategory, RecurrenceFreq } from '@/lib/database.types';

const PATH = '/dashboard/relationship';

export type ToggleDateCalendarResult =
  | { ok: true; onCalendar: boolean; eventId: string | null }
  | { ok: false; error: string };

/**
 * Put a relationship date on the calendar, or take it off.
 *
 * Reads the date from the DATABASE rather than trusting fields the browser sent,
 * so the event that lands says what the stored row says.
 */
export async function toggleDateOnCalendarAction(dateId: string): Promise<ToggleDateCalendarResult> {
  const t = await getTranslations();
  if (!dateId) return { ok: false, error: t('actions.thatDateCouldNotBe') };

  // Outside the try: `requireUserContext` redirects by throwing.
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);

  try {
    const { data: row, error: readError } = await supabase
      .from('relationship_dates')
      .select('id, kind, title, event_date, recurs_annually, location, calendar_event_id')
      .eq('id', dateId)
      .eq('family_id', ctx.active.familyId)
      .maybeSingle();
    if (readError) {
      console.error('[relationship-action] date read failed', readError);
      return { ok: false, error: t('actions.couldNotLoadThatDate') };
    }
    if (!row) return { ok: false, error: t('actions.thatDateCouldNotBe') };

    // ── Off the calendar ────────────────────────────────────────────────────
    if (row.calendar_event_id) {
      const removed = await deleteEvent(scope, row.calendar_event_id);
      // A `notFound` means the event is already gone — someone deleted it from
      // the calendar itself — so clearing the dangling link is the right repair
      // rather than an error the family can do nothing about. Any other failure
      // keeps the link, because the event is still there.
      // The constant, not the string: a renamed code should be a compile error
      // rather than a branch that silently stops matching.
      if (!removed.ok && removed.code !== SERVICE_CODES.notFound) {
        return { ok: false, error: removed.error };
      }

      const { error: unlinkError } = await supabase
        .from('relationship_dates')
        .update({ calendar_event_id: null })
        .eq('id', row.id)
        .eq('family_id', ctx.active.familyId);
      if (unlinkError) {
        console.error('[relationship-action] unlink failed', unlinkError);
        return { ok: false, error: t('actions.theEventWasRemovedBut') };
      }

      revalidatePath(PATH);
      return { ok: true, onCalendar: false, eventId: null };
    }

    // ── On to the calendar ──────────────────────────────────────────────────
    //
    // The shape still comes from `buildCalendarEventForDate`, which owns the
    // domain rules — all-day, noon UTC so the day is stable across zones,
    // birthdays in the birthday category, recurring dates as yearly events — and
    // has its own tests. Re-deriving them here would have been a second copy of
    // exactly the kind this work exists to remove.
    //
    // Its `family_id` and `created_by` are dropped on purpose: the service takes
    // both from the session, which is the point of routing through it.
    const built = buildCalendarEventForDate(
      {
        kind: row.kind,
        title: row.title,
        eventDate: row.event_date,
        recursAnnually: row.recurs_annually,
        location: row.location,
      },
      ctx.active.familyId,
      ctx.user.id,
    );
    const created = await createEvent(scope, {
      title: built.title,
      category: built.category as EventCategory,
      startsAt: built.starts_at,
      allDay: built.all_day ?? true,
      recurrence: built.recurrence as RecurrenceFreq,
      location: built.location ?? null,
    });
    if (!created.ok) return { ok: false, error: created.error };

    const { error: linkError } = await supabase
      .from('relationship_dates')
      .update({ calendar_event_id: created.data.id })
      .eq('id', row.id)
      .eq('family_id', ctx.active.familyId);
    if (linkError) {
      // The event exists and the family can see it; only the link is missing, so
      // report rather than delete work they can already use. Logged so a second
      // tap creating a second event is traceable.
      console.error('[relationship-action] link failed', { dateId: row.id, eventId: created.data.id, error: linkError });
      return { ok: false, error: t('actions.itIsOnYourCalendar') };
    }

    revalidatePath(PATH);
    return { ok: true, onCalendar: true, eventId: created.data.id };
  } catch (err) {
    console.error('[relationship-action] toggle failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotUpdateYourCalendar')) };
  }
}
