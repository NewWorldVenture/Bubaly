// The write path for every calendar change a person makes by hand.
//
// §7: "A parent on a patchy phone connection taps Save twice on a school
// concert and gets two identical events on the family calendar — the same
// double-tap through Bubaly is deduplicated and produces one." The asymmetry
// was structural, not accidental: Bubaly's writes went through
// `lib/services/calendar`, and the module's Save button went straight from the
// browser to PostgREST. Two write paths to one table, and only one of them had
// the guard.
//
// So these actions add nothing of their own. They resolve the session, hand the
// service the same `ServiceScope` the assistant's tools hand it, and return its
// `ServiceResult` for the modal to toast. What the UI gains is everything the
// service already did for Bubaly:
//
//   - the duplicate guard (`withIdempotency` + 0256's partial unique index),
//     armed by the submission id the browser mints per save attempt;
//   - server-side validation, including the end-before-start check the client
//     form does and the client form is the only thing enforcing;
//   - `family_id` from the SESSION rather than from a prop the browser sends,
//     so a client can no longer name the family it is writing into;
//   - `.eq('family_id')` on the update and delete, which the client path left
//     to RLS alone.
//
// DEPLOY COUPLING: the service names `idempotency_key` in its insert, which
// migration 0256 adds. That was already true of Bubaly's calendar writes; these
// actions extend it to the family's own Add Event button. See
// docs/PENDING_PROD_MIGRATIONS.md — 0256 must be applied before this ships.
'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import {
  createEvent, createEvents, deleteEvent, deleteEvents, updateEvent,
  EVENT_CATEGORIES, EVENT_RECURRENCES,
} from '@/lib/services/calendar';
import { makeKey } from '@/lib/services/idempotency';
import { scopeFromUserContext } from '@/lib/services/scope';
import { isSubmissionId } from '@/lib/utils/submission-id';
import { describeActionError } from '@/lib/supabase/errors';
import type { EventCategory, RecurrenceFreq } from '@/lib/database.types';

const PATH = '/dashboard/calendar';

export type CalendarActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export type CalendarEventFields = {
  title?: string;
  /** Either a `datetime-local` value or an absolute ISO instant — see `asStoredInstant`. */
  startsAt?: string;
  endsAt?: string | null;
  allDay?: boolean;
  category?: string;
  recurrence?: string;
  location?: string | null;
  description?: string | null;
  assigneeId?: string | null;
};

export type CreateCalendarEventInput = CalendarEventFields & {
  title: string;
  startsAt: string;
  /** Mints per save attempt in the browser; see `lib/utils/submission-id.ts`. */
  submissionId?: string;
};

/**
 * A `<input type="datetime-local">` value is a naive wall clock — "2026-09-10T14:30",
 * no zone. Today that string goes straight to PostgREST and Postgres resolves it
 * against the connection's `TimeZone`, which is UTC, so that is the instant every
 * hand-made event has ever been stored at.
 *
 * `Date.parse` would instead resolve a naive string against the *server's* zone.
 * On Vercel that is also UTC and nothing would change; on a laptop set to
 * America/Chicago the same form submission would land five hours away from where
 * production puts it. Stamping the `Z` here pins the stored instant to today's on
 * every machine, so moving the write to the server changes the write path and
 * nothing else.
 *
 * It is deliberately NOT a fix for the wall-clock question underneath — a family
 * in New York typing 2:30pm still gets 14:30Z, and seeing that back as 2:30pm
 * depends on how `toLocalInput` and the grid read it. That is a display change as
 * much as a storage one and does not belong in a commit about write paths.
 */
function asStoredInstant(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(v) ? `${v}Z` : v;
}

function asCategory(value: string | undefined): EventCategory | undefined {
  return EVENT_CATEGORIES.find((c) => c === value);
}

function asRecurrence(value: string | undefined): RecurrenceFreq | undefined {
  return EVENT_RECURRENCES.find((r) => r === value);
}

/** Trim to null, so "   " clears a field rather than storing whitespace. */
function asText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return value.trim() || null;
}

/**
 * The idempotency key for one save attempt, or null for "do not deduplicate".
 *
 * Namespaced by operation so a submission id that ever reached two different
 * writes could not have the second silently answered with the first's row — the
 * key lands verbatim in a column whose uniqueness is per family and per table,
 * and a collision there returns a row instead of an error.
 *
 * A missing or malformed id degrades to today's behaviour rather than failing
 * the save: deduplication is a safety net, and refusing a parent's event because
 * a generated id looked wrong would be a worse bug than the one being fixed.
 */
function submissionKey(operation: string, familyId: string, submissionId: unknown): string | null {
  return isSubmissionId(submissionId) ? makeKey([operation, familyId, submissionId]) : null;
}

/**
 * Shared session + scope resolution. Called OUTSIDE each action's `try`, and
 * that placement is load-bearing: `requireUserContext` sends a signed-out caller
 * to /login by calling `redirect()`, which works by throwing. Catching that
 * would turn the redirect into `{ ok: false }` and show a toast to someone who
 * should have been sent to the login page.
 */
async function calendarScope(extra?: { idempotencyKey?: string | null }) {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  return scopeFromUserContext(ctx, supabase, extra);
}

export async function createCalendarEventAction(input: CreateCalendarEventInput): Promise<CalendarActionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase, {
    idempotencyKey: submissionKey('calendar.createEvent', ctx.active.familyId, input.submissionId),
  });

  try {
    const startsAt = asStoredInstant(input.startsAt);
    if (!startsAt) return { ok: false, error: t('actions.pickAStartTimeFor') };

    const result = await createEvent(scope, {
      title: input.title ?? '',
      startsAt,
      endsAt: asStoredInstant(input.endsAt) ?? null,
      allDay: input.allDay ?? false,
      category: asCategory(input.category),
      recurrence: asRecurrence(input.recurrence),
      location: asText(input.location) ?? null,
      description: asText(input.description) ?? null,
      assigneeId: input.assigneeId ?? null,
    });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[calendar-action] create failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotAddThatEvent')) };
  }
}

export async function updateCalendarEventAction(
  eventId: string,
  patch: CalendarEventFields,
): Promise<CalendarActionResult> {
  const t = await getTranslations();
  if (!eventId) return { ok: false, error: t('actions.thatEventCouldNotBe') };
  const scope = await calendarScope();
  try {
    // `undefined` means "leave it alone" all the way down: the service builds its
    // update from the keys actually present, so a modal that shows four fields
    // cannot blank the assignee it never rendered.
    const result = await updateEvent(scope, eventId, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.startsAt !== undefined ? { startsAt: asStoredInstant(patch.startsAt) ?? '' } : {}),
      ...(patch.endsAt !== undefined ? { endsAt: asStoredInstant(patch.endsAt) ?? null } : {}),
      ...(patch.allDay !== undefined ? { allDay: patch.allDay } : {}),
      ...(patch.category !== undefined ? { category: asCategory(patch.category) } : {}),
      ...(patch.recurrence !== undefined ? { recurrence: asRecurrence(patch.recurrence) } : {}),
      ...(patch.location !== undefined ? { location: asText(patch.location) ?? null } : {}),
      ...(patch.description !== undefined ? { description: asText(patch.description) ?? null } : {}),
      ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
    });
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[calendar-action] update failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotUpdateThatEvent')) };
  }
}

export async function deleteCalendarEventAction(eventId: string): Promise<CalendarActionResult> {
  const t = await getTranslations();
  if (!eventId) return { ok: false, error: t('actions.thatEventCouldNotBe') };
  const scope = await calendarScope();
  try {
    const result = await deleteEvent(scope, eventId);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[calendar-action] delete failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotRemoveThatEvent')) };
  }
}

export type ApplyRoutineInput = {
  events: {
    title: string;
    startsAt: string;
    endsAt?: string | null;
    category?: string;
    assigneeId?: string | null;
  }[];
  /**
   * Minted per composition in the browser. Applying the same routine to the same
   * week twice is one composition, and adds one week of events rather than two.
   */
  submissionId?: string;
};

export type ApplyRoutineResult =
  | { ok: true; eventIds: string[] }
  | { ok: false; error: string };

/**
 * Materialise a routine into the week as ONE write.
 *
 * The rows still come from `materializeRoutine`, which owns the weekday and
 * time-of-day arithmetic and has its own tests; this only decides where they
 * land and under whose name.
 */
export async function applyRoutineToCalendarAction(input: ApplyRoutineInput): Promise<ApplyRoutineResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase, {
    idempotencyKey: submissionKey('calendar.applyRoutine', ctx.active.familyId, input.submissionId),
  });

  try {
    const events = input.events ?? [];
    if (!events.length) return { ok: false, error: t('actions.thisRoutineHasNoActive') };

    const result = await createEvents(scope, events.map((e) => ({
      title: e.title,
      startsAt: asStoredInstant(e.startsAt) ?? '',
      endsAt: asStoredInstant(e.endsAt) ?? null,
      category: asCategory(e.category),
      assigneeId: e.assigneeId ?? null,
      allDay: false,
      recurrence: 'none' as const,
    })));
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true, eventIds: result.data.map((e) => e.id) };
  } catch (err) {
    console.error('[calendar-action] apply routine failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotAddThoseEvents')) };
  }
}

export type UndoResult =
  | { ok: true; removed: number }
  | { ok: false; error: string };

/** The undo behind "added 12 events for this week". Family-scoped. */
export async function undoCalendarEventsAction(eventIds: string[]): Promise<UndoResult> {
  const t = await getTranslations();
  const scope = await calendarScope();
  try {
    const result = await deleteEvents(scope, eventIds ?? []);
    if (!result.ok) return { ok: false, error: result.error };
    revalidatePath(PATH);
    return { ok: true, removed: result.data.removed };
  } catch (err) {
    console.error('[calendar-action] undo failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotUndoThoseEvents')) };
  }
}
