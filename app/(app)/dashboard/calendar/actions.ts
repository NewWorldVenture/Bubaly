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
  createEvent, createEvents, deleteEvent, deleteEvents, updateEvent, normalizeCalendarWriteInstant,
  EVENT_CATEGORIES, EVENT_RECURRENCES,
} from '@/lib/services/calendar';
import { ALREADY_SAVED, makeKey } from '@/lib/services/idempotency';
import { scopeFromUserContext } from '@/lib/services/scope';
import { SERVICE_CODES } from '@/lib/services/types';
import { compareExactInstants } from '@/lib/calendar/exact-instant';
import { isSeries } from '@/lib/calendar/occurrences';
import { expandEventsInZone } from '@/lib/calendar/recurrence';
import { isSubmissionId } from '@/lib/utils/submission-id';
import { describeActionError } from '@/lib/supabase/errors';
import { loadScheduleIntelligence } from '@/lib/schedule/intelligence-server';
import type { ScheduleInsight } from '@/lib/schedule/intelligence';
import type { EventCategory, RecurrenceFreq } from '@/lib/database.types';

const PATH = '/dashboard/calendar';

export type CalendarActionResult =
  | { ok: true; id: string }
  /**
   * `already_saved` (creates only): this submission id already wrote an event,
   * and that event no longer matches the one just sent — see `KeyedCreateOptions`
   * in lib/services/idempotency.ts. That Save is settled, so the modal mints a
   * new id rather than retry it (`submissionSettled`).
   */
  | { ok: false; error: string; code?: typeof ALREADY_SAVED };

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
 * It is deliberately NOT a fix for the wall-clock question underneath, and the
 * reason was that seeing 2:30pm back depends on how `toLocalInput` and the grid
 * read it — a display change as much as a storage one, and not the business of a
 * commit about write paths.
 *
 * That coupling is exactly where the damage turned out to be. The prefill read a
 * stored instant on the READER's clock while this stamped the box value as UTC,
 * so the two were not inverses and each Save moved the event by the reader's
 * offset — compounding, and on synced rows too. Both ends now share the reader's
 * clock in `lib/time/local-input.ts`, and the calendar modal resolves its box
 * value there before calling, so what arrives here from that form is already an
 * absolute instant and falls through the passthrough below untouched.
 *
 * The naive branch is therefore for the callers that still send a wall clock —
 * the assistant's tools by way of `isoOrNull`, and the surfaces that hand these
 * actions a raw form value — and it keeps storing them where they have always
 * been stored. Whose clock a typed time should mean when the person typing is not
 * in the family's zone is still open, because answering it reinterprets rows
 * already in the column and nothing in a row says which convention wrote it.
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
    }, {
      // The key is a person's submission id, not a plan step: a changed Save
      // under it is a change of mind, not the same save (see KeyedCreateOptions).
      rejectChangedRetry: true,
    });
    if (!result.ok) {
      return result.code === ALREADY_SAVED
        ? { ok: false, error: result.error, code: ALREADY_SAVED }
        : { ok: false, error: result.error };
    }

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[calendar-action] create failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotAddThatEvent')) };
  }
}

/**
 * The row as the editor OPENED it. The modal sends every field on Save, so a
 * Save from a modal another member's change has overtaken wrote this older copy
 * of the time, place and notes back over theirs, silently.
 */
export type OpenedCalendarEvent = { startsAt: string; endsAt: string | null; allDay: boolean; updatedAt: string };

const sameOpenedInstant = (a: string | null, b: string | null): boolean => {
  if (a === null || b === null) return a === b;
  try { return compareExactInstants(a, b) === 0; } catch { return false; }
};

export async function updateCalendarEventAction(
  eventId: string,
  patch: CalendarEventFields,
  opened?: OpenedCalendarEvent,
): Promise<CalendarActionResult> {
  const t = await getTranslations();
  if (!eventId) return { ok: false, error: t('actions.thatEventCouldNotBe') };
  const scope = await calendarScope();
  try {
    // The clock and the version it was opened at must still be the row's, and
    // the write below is compared-and-set against what is read here, so a
    // change landing between this read and the write is refused as well.
    let current: Awaited<ReturnType<typeof readOpenedEvent>> = null;
    if (opened) {
      current = await readOpenedEvent(scope, eventId);
      if (!current) return { ok: false, error: t('actions.thatEventCouldNotBe') };
      if (!sameOpenedInstant(current.starts_at, opened.startsAt) || !sameOpenedInstant(current.ends_at, opened.endsAt)
        || current.all_day !== opened.allDay || current.updated_at !== opened.updatedAt) {
        return { ok: false, error: t('actions.thatEventChangedSinceThisPage') };
      }
    }
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
    }, current ?? undefined);
    if (!result.ok) {
      // Against an opened copy, no matching row means the compare-and-set lost.
      if (current && result.code === SERVICE_CODES.notFound) return { ok: false, error: t('actions.thatEventChangedSinceThisPage') };
      return { ok: false, error: result.error };
    }
    // A Smart Departure planned for the event has followed a move: the service
    // does that for every writer (lib/trips/follow-event.ts).

    revalidatePath(PATH);
    return { ok: true, id: result.data.id };
  } catch (err) {
    console.error('[calendar-action] update failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotUpdateThatEvent')) };
  }
}

/** The row's clock and version, family-scoped, for the opened-copy check. Throws on a failed read. */
async function readOpenedEvent(scope: Awaited<ReturnType<typeof calendarScope>>, eventId: string) {
  const { data, error } = await scope.db.from('calendar_events')
    .select('id, title, starts_at, ends_at, all_day, updated_at')
    .eq('id', eventId).eq('family_id', scope.familyId).maybeSingle();
  if (error) throw error;
  return data;
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
    // The batch key answers a repeated Apply with the rows the FIRST Apply of
    // this routine and week wrote. That is the double tap it exists for — and
    // the wrong answer when the routine was edited in between (a step added, a
    // time moved): "Added N events" came back with the old rows and none of the
    // change on the calendar. The rows answered must be the rows asked for.
    if (!sameRoutineRows(events, result.data)) return { ok: false, error: t('calendar.routineAlreadyAppliedAsItWas') };

    revalidatePath(PATH);
    return { ok: true, eventIds: result.data.map((e) => e.id) };
  } catch (err) {
    console.error('[calendar-action] apply routine failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotAddThoseEvents')) };
  }
}

/** Whether `stored` holds exactly the events `asked` for, in any order. */
function sameRoutineRows(
  asked: ApplyRoutineInput['events'],
  stored: { title: string; starts_at: string; ends_at: string | null; category: string; assignee_id: string | null }[],
): boolean {
  // Both sides as the one exact spelling the service stores; an unreadable
  // clock never equals anything.
  const instant = (value: string | null | undefined) => {
    const stamped = asStoredInstant(value);
    return stamped === undefined ? 'none' : normalizeCalendarWriteInstant(stamped, 'UTC') ?? `unreadable:${stamped}`;
  };
  const key = (title: string, startsAt: string, endsAt: string | null | undefined, category: string | undefined, assignee: string | null | undefined) =>
    JSON.stringify([title.trim(), instant(startsAt), instant(endsAt), category ?? 'general', (assignee ?? '').toLowerCase()]);
  const want = asked.map((e) => key(e.title, e.startsAt, e.endsAt, asCategory(e.category), e.assigneeId)).sort();
  const have = stored.map((e) => key(e.title, e.starts_at, e.ends_at, e.category, e.assignee_id)).sort();
  return want.length === have.length && want.every((value, i) => value === have[i]);
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

export type EventScheduleInsightsResult =
  | { ok: true; insights: ScheduleInsight[]; leaveBy: { at: string; source: 'drive_time' | 'category_buffer'; travelMinutes: number } | null }
  | { ok: false; error: string };

/**
 * The composed schedule model for ONE event (lib/schedule/intelligence): its
 * leave-by, and every driver, car, dinner, care and double-booking constraint
 * the rest of the family's day puts on it. Read-only.
 *
 * Fail-closed: a read failure is an error the modal shows with a retry, never
 * an empty list — "no conflicts" is a claim, and one computed from missing
 * rows would be false.
 */
export async function eventScheduleInsightsAction(eventId: string, occurrenceStartsAt?: string | null): Promise<EventScheduleInsightsResult> {
  const t = await getTranslations();
  if (!eventId) return { ok: false, error: t('actions.thatEventCouldNotBe') };
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const tz = ctx.active.family.timezone || 'UTC';
  try {
    const { data: event, error } = await supabase
      .from('calendar_events').select('id, starts_at, ends_at, all_day, recurrence, recurrence_until')
      .eq('id', eventId).eq('family_id', familyId).maybeSingle();
    if (error) {
      console.error('[schedule] event read failed', error);
      return { ok: false, error: t('actions.couldNotLoadScheduleInsights') };
    }
    if (!event) return { ok: false, error: t('actions.thatEventCouldNotBe') };
    if (event.all_day) return { ok: true, insights: [], leaveBy: null };

    // The occurrence the family OPENED. A series is stored once, at its first
    // week, so checking the stored start checked that week — long past for an
    // ongoing practice, which then always read "No conflicts found". The start
    // the browser names is held to the series: it must be one of its weeks.
    const startsAt = occurrenceStartsAt ? occurrenceOf(event, occurrenceStartsAt, tz) : event.starts_at;
    if (!startsAt) return { ok: false, error: t('actions.thatEventCouldNotBe') };
    const startMs = Date.parse(startsAt);
    if (!Number.isFinite(startMs)) return { ok: true, insights: [], leaveBy: null };
    // Everything that can constrain the event lives on the same family day,
    // give or take: a day either side covers overnight rides and late dinners.
    const result = await loadScheduleIntelligence(supabase, {
      familyId, tz, now: new Date(),
      fromMs: startMs - 86_400_000, toMs: startMs + 86_400_000,
      occurrence: { eventId, startsAt },
    });
    if (!result.ok) return { ok: false, error: t('actions.couldNotLoadScheduleInsights') };
    const sched = result.data.events.find((e) => e.eventId === eventId);
    return { ok: true, insights: result.data.byEvent[eventId] ?? [], leaveBy: sched?.leaveBy ?? null };
  } catch (err) {
    console.error('[schedule] event insights read failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotLoadScheduleInsights')) };
  }
}

/**
 * `startsAt` when it is a real occurrence of `event` — the stored start of a
 * one-off, or one of a series' own steps on the family's clock — else null.
 */
function occurrenceOf(
  event: { id: string; starts_at: string; ends_at: string | null; recurrence: RecurrenceFreq | null; recurrence_until: string | null },
  startsAt: string, tz: string,
): string | null {
  try {
    if (!isSeries(event)) return compareExactInstants(event.starts_at, startsAt) === 0 ? event.starts_at : null;
    const at = Date.parse(startsAt);
    if (!Number.isFinite(at)) return null;
    const hit = expandEventsInZone([{ ...event, recurrence: event.recurrence ?? 'none' }], new Date(at - 1), new Date(at + 1), tz)
      .find((row) => compareExactInstants(row.starts_at, startsAt) === 0);
    return hit?.starts_at ?? null;
  } catch {
    return null;
  }
}
