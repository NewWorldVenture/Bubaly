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
import { createEvent, deleteEvent, updateEvent } from '@/lib/services/calendar';
import { buildCalendarEventForDate } from '@/lib/relationship/calendar';
import { scopeFromUserContext } from '@/lib/services/scope';
import { SERVICE_CODES } from '@/lib/services/types';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
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

      // The calendar event is already gone by here. An unlink matching no rows
      // leaves `calendar_event_id` pointing at a deleted event, and the next
      // sync treats the date as already on the calendar — so it never goes back
      // on. Audit C1-S9-58.
      const { data: unlinked, error: unlinkError } = await supabase
        .from('relationship_dates')
        .update({ calendar_event_id: null })
        .eq('id', row.id)
        .eq('family_id', ctx.active.familyId)
        .select('id');
      if (unlinkError || wroteNoRows(unlinked)) {
        console.error('[relationship-action] unlink failed', unlinkError ?? 'no rows updated');
        return { ok: false, error: t('actions.theEventWasRemovedBut') };
      }

      revalidatePath(PATH);
      return { ok: true, onCalendar: false, eventId: null };
    }

    // ── On to the calendar ──────────────────────────────────────────────────
    //
    // The shape still comes from `buildCalendarEventForDate`, which owns the
    // domain rules — all-day UTC civil boundaries with an exclusive next day,
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
      endsAt: built.ends_at ?? null,
      allDay: built.all_day ?? true,
      recurrence: built.recurrence as RecurrenceFreq,
      location: built.location ?? null,
    });
    if (!created.ok) return { ok: false, error: created.error };

    // The event exists by now. A link matching no rows leaves the date not
    // knowing about it, so the next run creates a SECOND event for the same
    // anniversary — the failure is duplication, not absence.
    const { data: linked, error: linkError } = await supabase
      .from('relationship_dates')
      .update({ calendar_event_id: created.data.id })
      .eq('id', row.id)
      .eq('family_id', ctx.active.familyId)
      .select('id');
    if (linkError || wroteNoRows(linked)) {
      // The event exists and the family can see it; only the link is missing, so
      // report rather than delete work they can already use. Logged so a second
      // tap creating a second event is traceable.
      console.error('[relationship-action] link failed', {
        dateId: row.id, eventId: created.data.id, error: linkError?.message ?? 'no rows updated',
      });
      return { ok: false, error: t('actions.itIsOnYourCalendar') };
    }

    revalidatePath(PATH);
    return { ok: true, onCalendar: true, eventId: created.data.id };
  } catch (err) {
    console.error('[relationship-action] toggle failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotUpdateYourCalendar')) };
  }
}

export type RelationshipDateResult = { ok: true } | { ok: false; error: string };

/**
 * Bring a date's calendar event in line with the date, after an edit.
 *
 * The module's edit wrote the date row alone, so a moved anniversary kept its
 * event on the old day (and the old title, recurrence and place) while the date
 * still read "on your calendar". The event is rebuilt from the STORED row by the
 * same builder that created it, so the two cannot describe different days.
 */
export async function syncDateOnCalendarAction(dateId: string): Promise<RelationshipDateResult> {
  const t = await getTranslations();
  if (!dateId) return { ok: false, error: t('actions.thatDateCouldNotBe') };
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
    if (!row.calendar_event_id) return { ok: true };

    const built = buildCalendarEventForDate(
      { kind: row.kind, title: row.title, eventDate: row.event_date, recursAnnually: row.recurs_annually, location: row.location },
      ctx.active.familyId,
      ctx.user.id,
    );
    const updated = await updateEvent(scope, row.calendar_event_id, {
      title: built.title,
      category: built.category as EventCategory,
      startsAt: built.starts_at,
      endsAt: built.ends_at ?? null,
      allDay: built.all_day ?? true,
      recurrence: built.recurrence as RecurrenceFreq,
      location: built.location ?? null,
    });
    if (updated.ok) {
      revalidatePath(PATH);
      return { ok: true };
    }
    if (updated.code !== SERVICE_CODES.notFound) return { ok: false, error: updated.error };

    // `notFound` answers two different things. The event may be gone (deleted
    // from the calendar itself), or the service's guard on the start, end and
    // all-day it read may have lost to a write that landed in between — a
    // second sync of this same date, an edit on the calendar. Clearing the link
    // on the second unlinked an event that is still there and reported success.
    // So read the event back: only a row absent for this family is gone. One
    // that is still there keeps its link, and the sync is refused so the family
    // can save again (the module keeps the edit open on this error).
    const { data: stillThere, error: recheckError } = await supabase
      .from('calendar_events')
      .select('id')
      .eq('id', row.calendar_event_id)
      .eq('family_id', ctx.active.familyId)
      .maybeSingle();
    if (recheckError) {
      console.error('[relationship-action] event re-check after a missed update failed', recheckError);
      return { ok: false, error: t('actions.couldNotUpdateYourCalendar') };
    }
    if (stillThere) return { ok: false, error: t('actions.theCalendarEventChangedWhileSaving') };

    // Confirmed gone: clear the dangling link, as the toggle does, so the date
    // stops claiming it — and only the link to THAT event, so one a concurrent
    // toggle has put there since is not cleared with it.
    const { data: unlinked, error: unlinkError } = await supabase
      .from('relationship_dates')
      .update({ calendar_event_id: null })
      .eq('id', row.id)
      .eq('family_id', ctx.active.familyId)
      .eq('calendar_event_id', row.calendar_event_id)
      .select('id');
    if (unlinkError || wroteNoRows(unlinked)) {
      console.error('[relationship-action] unlink after a missing event failed', unlinkError ?? 'no rows updated');
      return { ok: false, error: t('actions.couldNotUpdateYourCalendar') };
    }
    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    console.error('[relationship-action] calendar sync failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotUpdateYourCalendar')) };
  }
}

/**
 * Remove a relationship date, and its calendar event with it.
 *
 * The module deleted the date row directly. `calendar_event_id` points FROM the
 * date TO the event (ON DELETE SET NULL the other way), so nothing removed the
 * event: an anniversary deleted here stayed on the family calendar every year.
 * The event goes first; a date whose event could not be removed is kept, so the
 * family can still take it off from here.
 */
export async function removeRelationshipDateAction(dateId: string): Promise<RelationshipDateResult> {
  const t = await getTranslations();
  if (!dateId) return { ok: false, error: t('actions.thatDateCouldNotBe') };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);

  try {
    const { data: row, error: readError } = await supabase
      .from('relationship_dates')
      .select('id, calendar_event_id')
      .eq('id', dateId)
      .eq('family_id', ctx.active.familyId)
      .maybeSingle();
    if (readError) {
      console.error('[relationship-action] date read failed', readError);
      return { ok: false, error: t('actions.couldNotLoadThatDate') };
    }
    if (!row) return { ok: false, error: t('actions.thatDateCouldNotBe') };

    if (row.calendar_event_id) {
      const removed = await deleteEvent(scope, row.calendar_event_id);
      // Already gone from the calendar is the outcome wanted.
      if (!removed.ok && removed.code !== SERVICE_CODES.notFound) return { ok: false, error: removed.error };
    }

    const { data: deleted, error: deleteError } = await supabase
      .from('relationship_dates')
      .delete()
      .eq('id', row.id)
      .eq('family_id', ctx.active.familyId)
      .select('id');
    if (deleteError) return { ok: false, error: describeActionError(deleteError, t('errors.thatChangeWasNotSaved')) };
    if (wroteNoRows(deleted)) return { ok: false, error: t('errors.thatChangeWasNotSaved') };

    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    console.error('[relationship-action] remove failed', err);
    return { ok: false, error: describeActionError(err, t('errors.thatChangeWasNotSaved')) };
  }
}
