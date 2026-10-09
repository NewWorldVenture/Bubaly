// Calendar reads and writes for every caller: the module UI, the assistant's
// tools, and the crons that look ahead on the family's behalf.
//
// Two pieces of pure logic already exist and are reused rather than
// reimplemented: `detectConflicts` (`lib/home/conflicts.ts`) clusters
// overlapping events for one assignee, and `mergeIntervals`/`freeGaps`
// (`lib/calendar/scheduling.ts`) invert busy time into gaps. What is NOT
// reused is that module's working-hours clipping and its all-day handling:
// both call `Date#setHours`, which resolves against the *server's* timezone.
// On Vercel that is UTC, so "no meetings before 9am" would clip a New York
// family's day at 4am. The clipping here resolves 09:00 in `scope.tz`.
//
// Free-slot search is cross-source on purpose. A child's soccer practice lives
// in `sports_events` and a parent-teacher night in `school_events`; a slot that
// ignores them is not free, it is just unrecorded, and suggesting it is the
// fastest way to lose a family's trust in the assistant.
import 'server-only';
import { detectConflicts, type ConflictEvent, type EventConflict } from '@/lib/home/conflicts';
import { readCalendarOccurrences, readCalendarBusySource, readCountedRows } from '@/lib/calendar/occurrences';
import { readCalendarAvailability } from '@/lib/calendar/availability';
import { buildConflictAdvisories, conflictSubject, type CalendarConflictAdvisory, type CalendarConflictSubject } from '@/lib/calendar/conflict-advisories';
import { addDays } from '@/lib/calendar/day';
import { CALENDAR_SOURCE_ARCHIVE_ENABLED } from '@/lib/calendar/source-capability';
import { calendarDisplayDay } from '@/lib/calendar/display-spans';
import { validDay } from '@/lib/onboarding/ics-time';
import { calendarOpenWindowFilter, instantCalendarBounds, normalizeCalendarWindowInstant } from '@/lib/briefing/calendar-window';
import { freeGaps, intervalTicks, mergeIntervals, type Interval } from '@/lib/calendar/scheduling';
import { addExactMilliseconds, exactInstantMilliseconds, exactIntervalOf, formatExactInstant, inclusiveInstantStep, parseExactInstant } from '@/lib/calendar/exact-instant';
import { instantForIcsLocalTime, isValidTimezone } from '@/lib/time/zoned';
import type { EventCategory, Insertable, RecurrenceFreq, Tables, Updatable } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { settleAll } from '@/lib/supabase/settle';
import { recordActivitySafely } from '../activity';
import { keyedProbe, makeKey, sameId, withIdempotency, type KeyedCreateOptions } from '../idempotency';
import { dayKeyInTz, dayKeysBetween, scopeNow, zonedDayBoundsMs, zonedTimeMs } from '../scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';
import { escapeLike } from '@/lib/supabase/escape-like';
import { getTranslations } from '@/lib/i18n/server';

export type CalendarEvent = Tables<'calendar_events'>;

/**
 * The values `calendar_events.category` / `.recurrence` accept, exported so a
 * caller holding a string from a form can narrow to the enum instead of casting
 * it. A cast would compile and then hand PostgREST a value the enum rejects.
 */
export const EVENT_CATEGORIES: readonly EventCategory[] = ['general', 'school', 'sports', 'appointment', 'medication', 'maintenance', 'birthday', 'holiday', 'other'];
export const EVENT_RECURRENCES: readonly RecurrenceFreq[] = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

const CATEGORIES = EVENT_CATEGORIES;
const RECURRENCES = EVENT_RECURRENCES;

/** Default length assumed for an event with no end, matching `detectConflicts`. */
const DEFAULT_DURATION_MIN = 60;
const MINUTE_MS = 60_000;

export function normalizeCalendarWriteInstant(value: string | null | undefined, timezone: string): string | null {
  if (!value?.trim()) return null;
  try {
    const token = value.trim().replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/, '$1:00$2');
    const exact = parseExactInstant(normalizeCalendarWindowInstant(token, timezone));
    if (exact % 1000n !== 0n) return null; // PostgreSQL stores microseconds: never round.
    return formatExactInstant(exact);
  } catch { return null; }
}
function invalidOptionalClock(value: string | null | undefined, normalized: string | null): boolean {
  return Boolean(value?.trim()) && normalized === null;
}
function sameCalendarInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  try { return parseExactInstant(a) === parseExactInstant(b); } catch { return false; }
}
// DATE labels belong to the caller's original civil prefix; UTC normalization
// must not silently move an all-day label to a different date.
function validEventRange(start: string, end: string | null, allDay: boolean, originalStart = start, originalEnd = end): boolean {
  try {
    const from = parseExactInstant(start), to = end === null ? null : parseExactInstant(end);
    if (typeof allDay !== 'boolean' || to !== null && to < from) return false;
    return !allDay || from === parseExactInstant(originalStart.trim().slice(0, 10) + 'T00:00:00Z')
      && (to === null || to > from && to === parseExactInstant(originalEnd!.trim().slice(0, 10) + 'T00:00:00Z'));
  } catch { return false; }
}

export type CreateEventInput = {
  title: string;
  startsAt: string;
  endsAt?: string | null;
  allDay?: boolean;
  category?: EventCategory;
  location?: string | null;
  description?: string | null;
  assigneeId?: string | null;
  recurrence?: RecurrenceFreq;
  recurrenceUntil?: string | null;
};

/** The columns a create chooses, as its insert writes them. */
type EventContent = Pick<CalendarEvent,
  'title' | 'description' | 'location' | 'category' | 'starts_at' | 'ends_at' | 'all_day' | 'recurrence' | 'recurrence_until' | 'assignee_id'>;

/**
 * `ChangedRetry.drift` for an event: the columns on which the row found under
 * the key differs from what this create would have written. The three
 * timestamps are compared as instants, since PostgREST returns a `timestamptz`
 * in its own text form. Names only — the values are the family's own text.
 */
function eventDrift(stored: CalendarEvent, wanted: EventContent): string[] {
  const drift: string[] = [];
  if (stored.title !== wanted.title) drift.push('title');
  if ((stored.description ?? null) !== wanted.description) drift.push('description');
  if ((stored.location ?? null) !== wanted.location) drift.push('location');
  if (stored.category !== wanted.category) drift.push('category');
  if (!sameCalendarInstant(stored.starts_at, wanted.starts_at)) drift.push('starts_at');
  if (!sameCalendarInstant(stored.ends_at, wanted.ends_at)) drift.push('ends_at');
  if (stored.all_day !== wanted.all_day) drift.push('all_day');
  if (stored.recurrence !== wanted.recurrence) drift.push('recurrence');
  if (!sameCalendarInstant(stored.recurrence_until, wanted.recurrence_until)) drift.push('recurrence_until');
  if (!sameId(stored.assignee_id, wanted.assignee_id)) drift.push('assignee_id');
  return drift;
}

/**
 * Create an event.
 *
 * `calendar_events.created_by` references `auth.users` (0002), so the auth user
 * id is correct here — unlike `todo_lists`/`todo_items`, which reference
 * `family_members`. Each service resolves this per column against the
 * migration that created the table; the two are not interchangeable.
 */
export async function createEvent(
  scope: ServiceScope,
  input: CreateEventInput,
  opts: KeyedCreateOptions = {},
): Promise<ServiceResult<CalendarEvent>> {
  const title = input.title?.trim() ?? '';
  if (!title) return fail('An event needs a title.', { code: SERVICE_CODES.invalidInput });

  const startsAt = normalizeCalendarWriteInstant(input.startsAt, scope.tz);
  if (!startsAt) return fail('That start time could not be understood.', { code: SERVICE_CODES.invalidInput });

  const endsAt = normalizeCalendarWriteInstant(input.endsAt, scope.tz);
  if (invalidOptionalClock(input.endsAt, endsAt) || !validEventRange(startsAt, endsAt, input.allDay ?? false, input.startsAt, input.endsAt ?? null)) {
    return fail('An event cannot end before it starts.', { code: SERVICE_CODES.invalidInput });
  }

  const recurrenceUntil = normalizeCalendarWriteInstant(input.recurrenceUntil, scope.tz);
  if (invalidOptionalClock(input.recurrenceUntil, recurrenceUntil)) return fail('That recurrence end could not be understood.', { code: SERVICE_CODES.invalidInput });

  const category = input.category && CATEGORIES.includes(input.category) ? input.category : 'general';
  const recurrence = input.recurrence && RECURRENCES.includes(input.recurrence) ? input.recurrence : 'none';
  /** The columns this create chooses, as the insert below writes them. */
  const wanted: EventContent = {
    title,
    description: input.description?.trim() || null,
    location: input.location?.trim() || null,
    category,
    starts_at: startsAt,
    ends_at: endsAt,
    all_day: input.allDay ?? false,
    recurrence,
    recurrence_until: recurrenceUntil,
    assignee_id: input.assigneeId ?? null,
  };

  return withIdempotency<CalendarEvent>(
    scope,
    {
      operation: 'calendar.createEvent',
      input: { title, startsAt, allDay: input.allDay ?? false },
      // 0256's `idempotency_key` + partial unique index: the retried call finds
      // its own row rather than a coincidence, and two retries racing cannot
      // both insert.
      find: keyedProbe(scope, 'calendar_events', 'event'),
      // The modal's Save, not a plan step (see KeyedCreateOptions): a row found
      // under the key that differs from `wanted` is refused with copy naming the
      // event that really was saved, instead of closing the modal over it.
      changedRetry: opts.rejectChangedRetry ? {
        drift: (stored) => eventDrift(stored, wanted),
        message: async (stored) => (await getTranslations())('calendar.alreadySavedAs', { title: stored.title }),
        id: (stored) => stored.id,
      } : undefined,
    },
    async (key) => {
      if (wanted.assignee_id != null) {
        const { data: assignee, error: assigneeError } = await scope.db
          .from('family_members')
          .select('id,family_id')
          .eq('family_id', scope.familyId)
          .eq('id', wanted.assignee_id)
          .maybeSingle();

        if (assigneeError) {
          return fail(describeDbError(assigneeError, 'Could not check that event assignee.'), { code: SERVICE_CODES.db });
        }
        if (!assignee || typeof assignee !== 'object' || Array.isArray(assignee)
          || typeof assignee.id !== 'string' || typeof assignee.family_id !== 'string'
          || !sameId(assignee.id, wanted.assignee_id) || !sameId(assignee.family_id, scope.familyId)) {
          return fail('Choose an assignee from your family.', { code: SERVICE_CODES.invalidInput });
        }
      }

      const { data, error } = await scope.db
        .from('calendar_events')
        .insert({
          family_id: scope.familyId,
          ...wanted,
          created_by: scope.userId,
          idempotency_key: key,
        })
        .select('*')
        .single();

      if (error || !data) {
        console.error('[service:calendar] create failed', error);
        return fail(describeDbError(error, 'Could not add that event.'), { code: SERVICE_CODES.db });
      }

      await recordActivitySafely(scope, {
        agent: 'calendar',
        action: 'create',
        title: `Added "${title}" to the calendar`,
        detail: new Date(startsAt).toISOString(),
        href: '/dashboard/calendar',
        memberId: input.assigneeId ?? null,
      });
      return ok(data);
    },
  );
}

/**
 * Create several events as ONE write — a routine materialised across a week, a
 * flyer's worth of fixtures.
 *
 * Not a loop over `createEvent`. A loop is N round trips, and a failure halfway
 * leaves half a routine on the calendar with nothing to undo it. A single
 * multi-row INSERT is atomic in Postgres: every row lands or none does.
 *
 * That atomicity is also what makes the batch deduplicable. Given a
 * `scope.idempotencyKey`, each row gets a key derived from it and the row's
 * position, so:
 *
 *   - the probe asks whether ANY row of this batch is present. Because the
 *     insert is all-or-nothing, "any" answers "all" — there is no half-applied
 *     batch to reason about. The probe is an OPTIMISATION, not the guarantee:
 *     removing it changes nothing a caller can observe, because the index below
 *     still refuses the second insert and the recovery returns the same rows;
 *   - if the probe finds them, they are returned and nothing is written, so a
 *     double-tapped Apply adds one week of events rather than two;
 *   - if two taps race past the probe, the second loses the partial unique index
 *     from 0256 and is answered with the winner's rows.
 *
 * Without a key it inserts directly, which is what the callers that have no
 * composition to name still do.
 */
export async function createEvents(
  scope: ServiceScope,
  inputs: CreateEventInput[],
): Promise<ServiceResult<CalendarEvent[]>> {
  if (!inputs.length) return fail('There were no events to add.', { code: SERVICE_CODES.invalidInput });

  const rows: Insertable<'calendar_events'>[] = [];
  for (const input of inputs) {
    const title = input.title?.trim() ?? '';
    if (!title) return fail('An event needs a title.', { code: SERVICE_CODES.invalidInput });
    const startsAt = normalizeCalendarWriteInstant(input.startsAt, scope.tz);
    if (!startsAt) return fail('That start time could not be understood.', { code: SERVICE_CODES.invalidInput });
    const endsAt = normalizeCalendarWriteInstant(input.endsAt, scope.tz);
    if (invalidOptionalClock(input.endsAt, endsAt) || !validEventRange(startsAt, endsAt, input.allDay ?? false, input.startsAt, input.endsAt ?? null)) {
      return fail('An event cannot end before it starts.', { code: SERVICE_CODES.invalidInput });
    }
    const recurrenceUntil = normalizeCalendarWriteInstant(input.recurrenceUntil, scope.tz);
    if (invalidOptionalClock(input.recurrenceUntil, recurrenceUntil)) return fail('That recurrence end could not be understood.', { code: SERVICE_CODES.invalidInput });
    rows.push({
      family_id: scope.familyId,
      title,
      description: input.description?.trim() || null,
      location: input.location?.trim() || null,
      category: input.category && CATEGORIES.includes(input.category) ? input.category : 'general',
      starts_at: startsAt,
      ends_at: endsAt,
      all_day: input.allDay ?? false,
      recurrence: input.recurrence && RECURRENCES.includes(input.recurrence) ? input.recurrence : 'none',
      recurrence_until: recurrenceUntil,
      assignee_id: input.assigneeId ?? null,
      created_by: scope.userId,
      idempotency_key: null,
    });
  }

  const batchKey = scope.idempotencyKey;
  if (batchKey) {
    const keys = rows.map((_, i) => makeKey(['calendar.createEvents', scope.familyId, batchKey, i]));
    rows.forEach((row, i) => { row.idempotency_key = keys[i]!; });

    const seen = await findByKeys(scope, keys);
    if (!seen.ok) return seen;
    if (seen.data.length > 0) return ok(seen.data);
  }

  const assigneeIds = rows
    .map((row) => row.assignee_id)
    .filter((id): id is string => id != null)
    .filter((id, index, ids) => ids.findIndex((other) => sameId(other, id)) === index);
  if (assigneeIds.length) {
    const { data: members, error: memberError } = await scope.db
      .from('family_members')
      .select('id, family_id')
      .eq('family_id', scope.familyId)
      .in('id', assigneeIds);
    if (memberError) {
      return fail(describeDbError(memberError, 'Could not check those assignees.'), { code: SERVICE_CODES.db });
    }
    if (!Array.isArray(members) || !members.every((member) => member && typeof member === 'object'
      && !Array.isArray(member) && typeof member.id === 'string' && typeof member.family_id === 'string'
      && sameId(member.family_id, scope.familyId) && assigneeIds.some((id) => sameId(member.id, id)))
      || !assigneeIds.every((id) => members.some((member) => sameId(member.id, id)))) {
      return fail('Choose assignees from your family.', { code: SERVICE_CODES.invalidInput });
    }
  }

  const { data, error } = await scope.db.from('calendar_events').insert(rows).select('*');
  if (error || !data) {
    // On a keyed batch this is what losing the race looks like: the winner's
    // rows are the honest answer. A failure with nothing behind it is returned
    // unchanged, so a real error is never disguised as success.
    if (batchKey) {
      const raced = await findByKeys(scope, rows.map((r) => r.idempotency_key!).filter(Boolean));
      if (raced.ok && raced.data.length > 0) return ok(raced.data);
    }
    console.error('[service:calendar] batch create failed', error);
    return fail(describeDbError(error, 'Could not add those events.'), { code: SERVICE_CODES.db });
  }

  await recordActivitySafely(scope, {
    agent: 'calendar',
    action: 'create',
    title: data.length === 1 ? `Added "${data[0]!.title}" to the calendar` : `Added ${data.length} events to the calendar`,
    detail: data.map((e) => e.title).join(', ').slice(0, 500),
    href: '/dashboard/calendar',
  });
  return ok(data);
}

/** The rows of a keyed batch that are already on the calendar, if any. */
async function findByKeys(scope: ServiceScope, keys: string[]): Promise<ServiceResult<CalendarEvent[]>> {
  const { data, error } = await scope.db
    .from('calendar_events')
    .select('*')
    .eq('family_id', scope.familyId)
    .in('idempotency_key', keys);
  if (error) {
    console.error('[service:calendar] batch duplicate probe failed', error);
    return fail(describeDbError(error, 'Could not check for duplicate events.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

/**
 * Remove several events at once — the undo behind "added 12 events for this
 * week". Family-scoped, where the client deleted on ids alone.
 */
export async function deleteEvents(scope: ServiceScope, eventIds: string[]): Promise<ServiceResult<{ removed: number }>> {
  const ids = eventIds.filter(Boolean);
  if (!ids.length) return ok({ removed: 0 });

  const { data, error } = await scope.db
    .from('calendar_events')
    .delete()
    .eq('family_id', scope.familyId)
    .in('id', ids)
    .is('feed_id', null)
    .is('external_uid', null)
    .select('id, title');
  if (error) {
    console.error('[service:calendar] batch delete failed', error);
    return fail(describeDbError(error, 'Could not undo those events.'), { code: SERVICE_CODES.db });
  }

  if (data != null && !Array.isArray(data)) {
    return fail('Could not confirm those events were removed.', { code: SERVICE_CODES.db });
  }
  const removed = data ?? [];
  // The batch create records a line; without this its Undo left none, so the
  // trail showed a week going onto the calendar and never coming off.
  if (removed.length) {
    await recordActivitySafely(scope, {
      agent: 'calendar',
      action: 'delete',
      title: removed.length === 1
        ? `Removed "${removed[0]!.title}" from the calendar`
        : `Removed ${removed.length} events from the calendar`,
      detail: removed.map((r) => r.title).join(', ').slice(0, 500),
      href: '/dashboard/calendar',
    });
  }
  return ok({ removed: removed.length });
}

export type UpdateEventPatch = Partial<Omit<CreateEventInput, 'title'>> & { title?: string };

type EventClockState = Pick<CalendarEvent, 'id' | 'title' | 'starts_at' | 'ends_at' | 'all_day'>;
export async function updateEvent(scope: ServiceScope, eventId: string, patch: UpdateEventPatch): Promise<ServiceResult<CalendarEvent>> {
  return applyEventUpdate(scope, eventId, patch);
}
async function applyEventUpdate(scope: ServiceScope, eventId: string, patch: UpdateEventPatch, captured?: EventClockState): Promise<ServiceResult<CalendarEvent>> {
  const update: Updatable<'calendar_events'> = {};

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) return fail('An event needs a title.', { code: SERVICE_CODES.invalidInput });
    update.title = title;
  }
  if (patch.startsAt !== undefined) {
    const startsAt = normalizeCalendarWriteInstant(patch.startsAt, scope.tz);
    if (!startsAt) return fail('That start time could not be understood.', { code: SERVICE_CODES.invalidInput });
    update.starts_at = startsAt;
  }
  if (patch.endsAt !== undefined) {
    const end = normalizeCalendarWriteInstant(patch.endsAt, scope.tz);
    if (invalidOptionalClock(patch.endsAt, end)) return fail('That end time could not be understood.', { code: SERVICE_CODES.invalidInput });
    update.ends_at = end;
  }
  if (patch.allDay !== undefined) update.all_day = patch.allDay;
  if (patch.location !== undefined) update.location = patch.location?.trim() || null;
  if (patch.description !== undefined) update.description = patch.description?.trim() || null;
  if (patch.assigneeId !== undefined) update.assignee_id = patch.assigneeId;
  if (patch.category !== undefined && CATEGORIES.includes(patch.category)) update.category = patch.category;
  if (patch.recurrence !== undefined && RECURRENCES.includes(patch.recurrence)) update.recurrence = patch.recurrence;
  if (patch.recurrenceUntil !== undefined) {
    const until = normalizeCalendarWriteInstant(patch.recurrenceUntil, scope.tz);
    if (invalidOptionalClock(patch.recurrenceUntil, until)) return fail('That recurrence end could not be understood.', { code: SERVICE_CODES.invalidInput });
    update.recurrence_until = until;
  }

  if (Object.keys(update).length === 0) {
    return fail('Nothing to change on that event.', { code: SERVICE_CODES.invalidInput });
  }

  if (update.starts_at && update.ends_at && parseExactInstant(update.ends_at) < parseExactInstant(update.starts_at)) {
    return fail('An event cannot end before it starts.', { code: SERVICE_CODES.invalidInput });
  }
  let clockState: EventClockState | undefined = captured;
  if (patch.startsAt !== undefined || patch.endsAt !== undefined || patch.allDay !== undefined) {
    if (!clockState) {
      const { data, error } = await scope.db.from('calendar_events')
        .select('id,title,starts_at,ends_at,all_day').eq('id', eventId).eq('family_id', scope.familyId).maybeSingle();
      if (error) return fail(describeDbError(error, 'Could not load that event.'), { code: SERVICE_CODES.db });
      if (!data) return fail('That event could not be found.', { code: SERVICE_CODES.notFound });
      clockState = data;
    }
    if (!validEventRange(update.starts_at ?? clockState.starts_at,
      patch.endsAt === undefined ? clockState.ends_at : update.ends_at ?? null,
      update.all_day ?? clockState.all_day, patch.startsAt ?? clockState.starts_at,
      patch.endsAt === undefined ? clockState.ends_at : patch.endsAt)) return fail('Choose valid event date boundaries.', { code: SERVICE_CODES.invalidInput });
  }

  if (update.assignee_id != null) {
    const { data: assignee, error: assigneeError } = await scope.db
      .from('family_members')
      .select('id,family_id')
      .eq('family_id', scope.familyId)
      .eq('id', update.assignee_id)
      .maybeSingle();

    if (assigneeError) {
      return fail(describeDbError(assigneeError, 'Could not check that event assignee.'), { code: SERVICE_CODES.db });
    }
    if (!assignee || typeof assignee !== 'object' || Array.isArray(assignee)
      || typeof assignee.id !== 'string' || typeof assignee.family_id !== 'string'
      || !sameId(assignee.id, update.assignee_id) || !sameId(assignee.family_id, scope.familyId)) {
      return fail('Choose an assignee from your family.', { code: SERVICE_CODES.invalidInput });
    }
  }

  let mutation = scope.db.from('calendar_events').update(update).eq('id', eventId).eq('family_id', scope.familyId)
    .is('feed_id', null).is('external_uid', null);
  if (clockState) {
    mutation = mutation.eq('starts_at', clockState.starts_at).eq('all_day', clockState.all_day);
    mutation = clockState.ends_at === null ? mutation.is('ends_at', null) : mutation.eq('ends_at', clockState.ends_at);
  }
  const { data, error } = await mutation.select('*').maybeSingle();

  if (error) {
    console.error('[service:calendar] update failed', error);
    return fail(describeDbError(error, 'Could not update that event.'), { code: SERVICE_CODES.db });
  }
  // No row means the id belongs to another family (or is gone). Reporting
  // "not found" rather than "denied" avoids confirming that the id exists.
  if (!data) return fail('That event could not be found.', { code: SERVICE_CODES.notFound });

  await recordActivitySafely(scope, {
    agent: 'calendar',
    action: 'update',
    title: `Updated "${data.title}"`,
    href: '/dashboard/calendar',
    memberId: data.assignee_id,
  });
  return ok(data);
}

export async function deleteEvent(scope: ServiceScope, eventId: string): Promise<ServiceResult<{ id: string; title: string }>> {
  const { data, error } = await scope.db
    .from('calendar_events')
    .delete()
    .eq('id', eventId)
    .eq('family_id', scope.familyId)
    .is('feed_id', null)
    .is('external_uid', null)
    .select('id, title')
    .maybeSingle();

  if (error) {
    console.error('[service:calendar] delete failed', error);
    return fail(describeDbError(error, 'Could not remove that event.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That event could not be found.', { code: SERVICE_CODES.notFound });

  await recordActivitySafely(scope, { action: 'delete', agent: 'calendar', title: `Removed "${data.title}" from the calendar`, href: '/dashboard/calendar' });
  return ok({ id: data.id, title: data.title });
}

export type SearchEventsInput = {
  from?: string | null;
  to?: string | null;
  query?: string | null;
  assigneeId?: string | null;
  categories?: EventCategory[];
  limit?: number;
  /**
   * Expand a recurring event into the occurrences that fall in the window —
   * the default, because a weekly practice IS on the calendar every week.
   * `false` returns the stored rows, a series once at its first start, for a
   * caller that wants the records themselves (the privacy export).
   */
  expandSeries?: boolean;
};

/**
 * How far ahead a series is expanded when the window has no end. One-off rows
 * stay open-ended, as they always were; a series cannot be, and a year covers
 * every frequency the calendar offers at least once.
 */
const SEARCH_SERIES_HORIZON_MS = 366 * 24 * 3600_000;

/** The family's zone for expanding a series; a scope carrying an unusable zone expands on UTC rather than failing the read. */
function zoneOf(scope: ServiceScope): string {
  return scope.tz && isValidTimezone(scope.tz) ? scope.tz : 'UTC';
}

/**
 * Events in a window, soonest first, series included: a recurring event is
 * returned once per occurrence in the window, at that occurrence's time. The
 * default window is open-ended forward.
 *
 * This read is the planner's eyes — the assistant's calendar tools, the weekly
 * schedule slice, the trip planner's conflict check all come through here —
 * and it used to filter `starts_at`, the FIRST start, by the window. A weekly
 * commitment created in August was therefore in no plan after August: the
 * assistant proposed dinners over practice and saw no clash in the week it
 * was asked about.
 */
export async function searchEvents(scope: ServiceScope, input: SearchEventsInput = {}): Promise<ServiceResult<CalendarEvent[]>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  let from: string, to: string | null;
  try {
    from = input.from == null ? scopeNow(scope).toISOString() : normalizeCalendarWindowInstant(input.from, scope.tz);
    to = input.to == null ? null : normalizeCalendarWindowInstant(input.to, scope.tz);
  } catch { return fail('That search window could not be understood.', { code: SERVICE_CODES.invalidInput }); }
  if (input.expandSeries === false) return searchEventRows(scope, input, from, to, limit);
  // A window that ends before it starts holds nothing, as the row read answered.
  if (to && parseExactInstant(to) < parseExactInstant(from)) return ok([]);

  const tz = zoneOf(scope);
  // `to` is inclusive, as the row read's `lte` was.
  const bounds = instantCalendarBounds(from, to ?? addExactMilliseconds(from, SEARCH_SERIES_HORIZON_MS - 1), tz);
  const res = await readCalendarOccurrences(scope.db, scope.familyId, bounds, tz, {
    limit,
    singlesLimit: limit,
    singlesFilter: to ? undefined : calendarOpenWindowFilter(bounds),
    assigneeId: input.assigneeId ?? undefined,
    refine: (query) => {
      let refined = query;
      if (input.categories?.length) refined = refined.in('category', input.categories);
      if (input.query?.trim()) refined = refined.ilike('title', `%${escapeLike(input.query.trim())}%`);
      return refined;
    },
  });
  if (res.error) {
    console.error('[service:calendar] search failed', res.error);
    return fail(describeDbError(res.error, 'Could not load the calendar.'), { code: SERVICE_CODES.db });
  }
  return ok(res.data);
}

/** The stored rows in a window by their own `starts_at`: a series once. */
async function searchEventRows(
  scope: ServiceScope, input: SearchEventsInput, from: string, to: string | null, limit: number,
): Promise<ServiceResult<CalendarEvent[]>> {
  if(CALENDAR_SOURCE_ARCHIVE_ENABLED||typeof scope.familyId!=='string'||!scope.familyId.trim())return fail('Could not load the calendar.',{code:SERVICE_CODES.db});
  const query = () => {
    let builder = scope.db.from('calendar_events').select('*', { count: 'exact' })
      .eq('family_id', scope.familyId).order('starts_at', { ascending: true }).order('id').gte('starts_at', from);
    if (to) builder = builder.lte('starts_at', to);
    if (input.assigneeId) builder = builder.eq('assignee_id', input.assigneeId);
    if (input.categories?.length) builder = builder.in('category', input.categories);
    if (input.query?.trim()) builder = builder.ilike('title', `%${escapeLike(input.query.trim())}%`);
    return builder;
  };
  const result = await readCountedRows<CalendarEvent>(() => query().limit(limit), (first,last) => query().range(first,last), 20_000, 'stored calendar rows', limit);
  if (result.error) return fail(describeDbError(result.error, 'Could not load the calendar.'), { code: SERVICE_CODES.db });
  try { validateCalendarRows(scope,result.data ?? []); }
  catch { return fail('Could not load the calendar.', { code: SERVICE_CODES.db }); }
  return ok(result.data ?? []);
}

/** This service consumes only genuine native rows. Never downgrade an archive
 * projection into an actionable native identity, or publish malformed scope. */
function validateCalendarRows(scope: ServiceScope, rows: readonly CalendarEvent[]): void {
  if(typeof scope.familyId!=='string'||!scope.familyId.trim()||rows.length>20_000)throw new Error('Invalid calendar domain');
  for(const row of rows){
    if(!row||row.family_id!==scope.familyId||typeof row.id!=='string'||!row.id.trim()
      ||typeof row.title!=='string'||typeof row.starts_at!=='string'||typeof row.all_day!=='boolean'
      ||row.assignee_id!==null&&typeof row.assignee_id!=='string'
      ||('source_recurrence' in row&&row.source_recurrence!==null))throw new Error('Invalid native calendar row');
    nativeInterval(row);
  }
}
function nativeInstant(value:string):number {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)||!validDay(value.slice(0,10)))throw new Error('Invalid native calendar instant');
  const valueMs=Date.parse(value);
  if(!Number.isFinite(valueMs)||+value.slice(11,13)>=24||+value.slice(14,16)>=60||+value.slice(17,19)>=60)throw new Error('Invalid native calendar instant');
  return exactInstantMilliseconds(parseExactInstant(value));
}
function nativeInterval(row: { starts_at:string; ends_at:string|null; all_day:boolean }) {
  if(!validDay(row.starts_at.slice(0,10))||!Number.isFinite(Date.parse(row.starts_at)))throw new Error('Invalid calendar start');
  if(row.all_day){
    const start=row.starts_at.slice(0,10),end=row.ends_at===null?addDays(start,1):row.ends_at.slice(0,10);
    if(!validDay(end)||end<=start||row.ends_at!==null&&!Number.isFinite(Date.parse(row.ends_at)))throw new Error('Invalid calendar DATE interval');
    if(parseExactInstant(row.starts_at)!==parseExactInstant(`${start}T00:00:00Z`)
      ||row.ends_at!==null&&parseExactInstant(row.ends_at)!==parseExactInstant(`${end}T00:00:00Z`))throw new Error('Noncanonical calendar DATE');
    return {allDay:true as const,start,end};
  }
  const start=nativeInstant(row.starts_at),end=row.ends_at===null?start+3_600_000:nativeInstant(row.ends_at);
  const exactInterval={start:row.starts_at,end:row.ends_at??addExactMilliseconds(row.starts_at,3_600_000)};
  if(parseExactInstant(exactInterval.end)<parseExactInstant(exactInterval.start))throw new Error('Invalid calendar interval');
  return {allDay:false as const,start,end,exactInterval};
}
function analysisWindow(scope:ServiceScope,input:{from?:string|null;to?:string|null},defaultDays:number) {
  if((input.from!=null&&!validDay(input.from.slice(0,10)))||(input.to!=null&&!validDay(input.to.slice(0,10))))throw new Error('Invalid calendar window');
  if(typeof scope.familyId!=='string'||!scope.familyId.trim()||typeof scope.tz!=='string'||!scope.tz.trim()||!isValidTimezone(scope.tz))throw new Error('Invalid family calendar scope');
  const fromIso=normalizeCalendarWindowInstant(input.from??scopeNow(scope).toISOString(),scope.tz);
  const toIso=normalizeCalendarWindowInstant(input.to??addExactMilliseconds(fromIso,defaultDays*86_400_000-1),scope.tz);
  const exactFrom=parseExactInstant(fromIso),exactTo=parseExactInstant(toIso);
  if(exactTo<exactFrom||exactTo-exactFrom>366n*86_400_000_000_000n)throw new Error('Invalid calendar window');
  const from=exactInstantMilliseconds(exactFrom),to=exactInstantMilliseconds(exactTo);
  const bounds=instantCalendarBounds(fromIso,toIso,scope.tz);
  return {from,to:to+1,bounds,exactFrom,exactTo:exactTo+inclusiveInstantStep(toIso)};
}

/**
 * Double-bookings in a window: one person, two overlapping timed events.
 * All-day and unassigned events are excluded by `detectConflicts` because they
 * are not a personal clash.
 */
export async function findConflicts(
  scope: ServiceScope,
  input: { from?: string | null; to?: string | null } = {},
): Promise<ServiceResult<{ conflicts: EventConflict[]; events: Record<string, CalendarEvent>; advisories: CalendarConflictAdvisory[]; subjects: Record<string, CalendarConflictSubject> }>> {
  let window:ReturnType<typeof analysisWindow>;
  try { window=analysisWindow(scope,input,366); }
  catch { return fail('That window could not be understood.', { code: SERVICE_CODES.invalidInput }); }
  const result=await readCalendarAvailability(scope.db,scope.familyId,window.bounds,scope.tz);
  if(result.error)return fail(describeDbError(result.error,'Could not load the calendar.'),{code:SERVICE_CODES.db});
  try {
    // Qualify the entire complete input before either personal or family advice.
    const advisories=buildConflictAdvisories(result.data,{timezone:scope.tz});
    const native=result.data.filter(row=>row.kind==='native');
    const events=native.map(row=>row.event);
    validateCalendarRows(scope,events);
    const conflictEvents:ConflictEvent[]=native.map(row=>({
      id:row.event.id,title:row.title,starts_at:row.starts_at,ends_at:row.ends_at,all_day:row.all_day,assignee_id:row.assignee_id,
      occurrenceKey:row.occurrenceKey,reference:row.reference,
    }));
    // Real native action identities and occurrence identities stay separate.
    const byId=Object.fromEntries(events.map(event=>[event.id,event]));
    const subjects=Object.fromEntries(native.map(row=>[row.occurrenceKey,conflictSubject(row)]));
    return ok({conflicts:detectConflicts(conflictEvents,DEFAULT_DURATION_MIN),events:byId,advisories,subjects});
  } catch { return fail('Could not load the calendar.',{code:SERVICE_CODES.db}); }
}

export type WorkingHours = { startHour: number; endHour: number };

export type FreeSlot = { startsAt: string; endsAt: string; dayKey: string };

export type FindFreeSlotsInput = {
  durationMin: number;
  from?: string | null;
  to?: string | null;
  /** Restrict busy time to these members; omit to treat every family commitment as busy. */
  memberIds?: string[];
  /** Local wall-clock hours in `scope.tz`. Defaults to 08:00–21:00 — waking family hours. */
  workingHours?: WorkingHours;
  limit?: number;
  /** Snap candidate starts to this grid, in minutes. */
  granularityMin?: number;
};

/**
 * Times when nobody in `memberIds` has a commitment, across the calendar,
 * school and sports tables.
 *
 * School and sports rows carry `member_id` (a `family_members` id) while
 * calendar rows carry `assignee_id`; an unassigned calendar event is treated
 * as busy for everyone, because "Family dinner" with no assignee is still the
 * whole family being unavailable.
 */
export async function findFreeSlots(scope: ServiceScope, input: FindFreeSlotsInput): Promise<ServiceResult<FreeSlot[]>> {
  if (typeof scope.tz !== 'string' || !scope.tz.trim() || !isValidTimezone(scope.tz)
    || typeof scope.familyId !== 'string' || !scope.familyId.trim()) return fail('That search window could not be understood.', { code: SERVICE_CODES.invalidInput });
  const durationMin = Math.max(Math.round(input.durationMin), 5);
  if (!Number.isFinite(durationMin)) return fail('That duration could not be understood.', { code: SERVICE_CODES.invalidInput });

  const now = scopeNow(scope);
  let fromIso: string, toIso: string, fromExact: bigint, toExact: bigint;
  try {
    fromIso=normalizeCalendarWindowInstant(input.from??now.toISOString(),scope.tz);
    toIso=normalizeCalendarWindowInstant(input.to??addExactMilliseconds(fromIso,7*24*3600_000),scope.tz);
    fromExact=parseExactInstant(fromIso);toExact=parseExactInstant(toIso);
    if(toExact<=fromExact)throw new Error('Invalid window');
  } catch {
    return fail('That search window could not be understood.', { code: SERVICE_CODES.invalidInput });
  }
  const fromMs=exactInstantMilliseconds(fromExact),toMs=exactInstantMilliseconds(toExact);
  const members = input.memberIds?.filter(Boolean) ?? [];

  // Series included: a weekly practice is busy every week, not the week it
  // was created. `to` is inclusive, as the row read's `lte` was.
  const tz = scope.tz;
  const [calendar, school, sports] = await settleAll([
    readCalendarAvailability(scope.db, scope.familyId, instantCalendarBounds(fromIso, toIso, tz), tz),
    readCalendarBusySource(scope.db, scope.familyId, 'school_events', fromIso, toIso, tz),
    readCalendarBusySource(scope.db, scope.familyId, 'sports_events', fromIso, toIso, tz),
  ]);

  // A free-slot suggestion is a source-of-truth read: a partial answer would
  // recommend a time that is already taken, so any source failing fails the call.
  for (const [label, res] of [['calendar', calendar], ['school', school], ['sports', sports]] as const) {
    if (res.error) {
      console.error(`[service:calendar] free-slot ${label} read failed`, res.error);
      return fail(describeDbError(res.error, 'Could not check everyone’s availability.'), { code: SERVICE_CODES.db });
    }
  }

  const busy: Interval[] = [];
  const push = (startsAt: string, endsAt: string | null) => {
    const start=parseExactInstant(startsAt),end=endsAt===null?start+BigInt(DEFAULT_DURATION_MIN*MINUTE_MS)*1_000_000n:parseExactInstant(endsAt);
    if(end===start)return;
    if(end<start)throw new Error('Invalid busy interval');
    busy.push({start:exactInstantMilliseconds(start),end:exactInstantMilliseconds(end),exactInterval:{start:startsAt,end:endsAt??formatExactInstant(end)}});
  };

  for (const e of calendar.data ?? []) {
    if (!e.occupied || members.length > 0 && e.attribution.kind === 'member' && !members.includes(e.attribution.memberId)) continue;
    // Source attendee identities are not household membership. Unmapped source
    // and native unassigned commitments conservatively occupy every member.
    busy.push({...e.interval,exactInterval:exactIntervalOf(e)});
  }
  for (const e of school.data ?? []) {
    if (members.length > 0 && e.member_id && !members.includes(e.member_id)) continue;
    push(e.starts_at, e.ends_at);
  }
  for (const e of sports.data ?? []) {
    if (members.length > 0 && e.member_id && !members.includes(e.member_id)) continue;
    push(e.starts_at, e.ends_at);
  }

  const hours = input.workingHours ?? { startHour: 8, endHour: 21 };
  const windows: Interval[] = [];
  for (const key of dayKeysBetween(fromMs, toMs, scope.tz)) {
    const open = zonedTimeMs(key, hours.startHour, 0, scope.tz);
    const close = zonedTimeMs(key, hours.endHour, 0, scope.tz);
    const start = Math.max(open, fromMs, now.getTime());
    const end = Math.min(close, toMs);
    const exactStart=[fromExact,BigInt(open)*1_000_000n,BigInt(now.getTime())*1_000_000n].reduce((a,b)=>a>b?a:b);
    const exactEnd=toExact<BigInt(close)*1_000_000n?toExact:BigInt(close)*1_000_000n;
    if (Number.isFinite(start) && Number.isFinite(end) && exactEnd > exactStart) windows.push({ start, end,exactInterval:{start:formatExactInstant(exactStart),end:formatExactInstant(exactEnd)} });
  }

  const merged = mergeIntervals(busy);
  const durationMs = durationMin * MINUTE_MS;
  const granMs = Math.max(input.granularityMin ?? 15, 1) * MINUTE_MS;
  const limit = Math.min(Math.max(input.limit ?? 6, 1), 50);

  const slots: FreeSlot[] = [];
  for (const window of windows) {
    for (const gap of freeGaps(merged, window.start, window.end,window.exactInterval)) {
      const exact=intervalTicks(gap),granularity=BigInt(granMs)*1_000_000n,duration=BigInt(durationMs)*1_000_000n;
      let start = exact.start;
      const remainder = (start % granularity+granularity)%granularity;
      if (remainder !== 0n) start += granularity - remainder;
      while (start + duration <= exact.end) {
        slots.push({
          startsAt: formatExactInstant(start),
          endsAt: formatExactInstant(start + duration),
          dayKey: dayKeyInTz(new Date(exactInstantMilliseconds(start)), scope.tz),
        });
        if (slots.length >= limit) return ok(slots);
        start += granularity;
      }
    }
  }
  return ok(slots);
}

/**
 * Which family-local evenings already have something on them — the input meal
 * planning uses to avoid proposing a from-scratch dinner on a practice night.
 * "Evening" is 17:00 local onward, resolved in `scope.tz`.
 */
export async function busyEvenings(
  scope: ServiceScope,
  input: { from?: string | null; to?: string | null; eveningFromHour?: number } = {},
): Promise<ServiceResult<string[]>> {
  const hour=input.eveningFromHour??17;
  if(!Number.isInteger(hour)||hour<0||hour>23)return fail('That window could not be understood.',{code:SERVICE_CODES.invalidInput});
  let window:ReturnType<typeof analysisWindow>;
  const evenings:{day:string;start:number;end:number}[]=[];
  try {
    window=analysisWindow(scope,input,7);
    for(let day=window.bounds.allDayFromDay;day<window.bounds.allDayToDay;day=addDays(day,1)){
      if(evenings.length>=367)throw new Error('Calendar day bound exceeded');
      const actual=calendarDisplayDay(day,scope.tz);
      const [year,month,date]=day.split('-').map(Number);
      const threshold=instantForIcsLocalTime(year,month,date,hour*60,scope.tz);
      if(!threshold)throw new Error('Invalid evening boundary');
      evenings.push({day,start:Math.max(window.from,actual.start,threshold.getTime()),end:Math.min(window.to,actual.end)});
    }
  } catch { return fail('That window could not be understood.',{code:SERVICE_CODES.invalidInput}); }
  const [calendar,sports]=await settleAll([
    readCalendarAvailability(scope.db,scope.familyId,window.bounds,scope.tz),
    readCalendarBusySource(scope.db,scope.familyId,'sports_events',new Date(window.from).toISOString(),new Date(window.to).toISOString(),scope.tz),
  ]);
  if(calendar.error||sports.error)return fail(describeDbError(calendar.error??sports.error,'Could not check the week ahead.'),{code:SERVICE_CODES.db});
  try {
    const intervals:Interval[]=(calendar.data??[]).filter(row=>row.occupied).map(row=>({...row.interval,exactInterval:exactIntervalOf(row)}));
    for(const row of sports.data??[]){
      if(typeof row.id!=='string'||!row.id.trim())throw new Error('Invalid sports identity');
      const interval=nativeInterval({...row,all_day:false});
      if(interval.allDay)throw new Error('Invalid sports interval');
      intervals.push(interval);
    }
    return ok(evenings.filter(evening=>{
      const start=window.exactFrom>BigInt(evening.start)*1_000_000n?window.exactFrom:BigInt(evening.start)*1_000_000n;
      const end=window.exactTo<BigInt(evening.end)*1_000_000n?window.exactTo:BigInt(evening.end)*1_000_000n;
      return end>start&&intervals.some(interval=>{const exact=intervalTicks(interval);return exact.start<end&&exact.end>start&&exact.end>exact.start;});
    }).map(evening=>evening.day));
  } catch { return fail('Could not check the week ahead.',{code:SERVICE_CODES.db}); }
}

/**
 * Move an event to a new start, keeping its length. Used when resolving a
 * conflict: the family agreed to move the thing, not to reshape it, so the
 * duration is preserved rather than reset to a default.
 */
export async function rescheduleAfter(
  scope: ServiceScope,
  eventId: string,
  input: { startsAt: string },
): Promise<ServiceResult<CalendarEvent>> {
  const startsAt = normalizeCalendarWriteInstant(input.startsAt, scope.tz);
  if (!startsAt) return fail('That new time could not be understood.', { code: SERVICE_CODES.invalidInput });

  const { data: existing, error: readError } = await scope.db
    .from('calendar_events')
    .select('id, title, starts_at, ends_at, all_day')
    .eq('id', eventId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (readError) {
    console.error('[service:calendar] reschedule read failed', readError);
    return fail(describeDbError(readError, 'Could not load that event.'), { code: SERVICE_CODES.db });
  }
  if (!existing) return fail('That event could not be found.', { code: SERVICE_CODES.notFound });

  if (!validEventRange(existing.starts_at, existing.ends_at, existing.all_day)) {
    return fail('Choose valid event date boundaries.', { code: SERVICE_CODES.invalidInput });
  }
  const duration = existing.ends_at === null ? null : parseExactInstant(existing.ends_at) - parseExactInstant(existing.starts_at);
  return applyEventUpdate(scope, eventId, {
    startsAt: input.startsAt,
    endsAt: duration === null ? null : formatExactInstant(parseExactInstant(startsAt) + duration),
  }, existing);
}

// ─── RSVPs ──────────────────────────────────────────────────────────────────

export type EventRsvp = Tables<'event_rsvps'>;
export type RsvpStatus = 'accepted' | 'maybe' | 'declined';

const RSVP_STATUSES: RsvpStatus[] = ['accepted', 'maybe', 'declined'];
const RSVP_LABELS: Record<RsvpStatus, string> = { accepted: 'Going', maybe: 'Maybe', declined: "Can't make it" };

/** How many title matches to look at before calling a request ambiguous. */
const RSVP_TITLE_CANDIDATES = 6;

export type ResolvedEvent = { id: string; title: string; starts_at: string; family_id: string };

/**
 * Find the ONE event a person meant by a partial title.
 *
 * The lookup this replaces — shared verbatim by the chat RSVP tool and its
 * read-only twin — was:
 *
 *     .ilike('title', `%${title}%`).order('starts_at', { ascending: false }).limit(1)
 *
 * Descending order takes the MAXIMUM `starts_at`, so "RSVP yes to swim" on a
 * weekly lesson resolved to the LAST occurrence of the term, months out, while
 * this week's stayed blank — and said "RSVP'd Going to Swim lesson", which
 * reads exactly like success. There was no lower bound either, so with no
 * future match it would happily answer for an event that had already happened.
 *
 * The rule here is the one a person means: the NEXT occurrence. Ambiguity is
 * refused rather than guessed, but only real ambiguity — several occurrences of
 * one weekly lesson are not a question, whereas "game" matching both
 * "Board game night" and "Away game vs Fairview" is, and the caller is told
 * both so they can say which.
 *
 * "Next occurrence" has to include a SERIES whose row started months ago: a
 * weekly swim lesson is one row with an August `starts_at`, and read by that
 * column alone it was "already happened" from its second week on. The series
 * is expanded here (lib/calendar/occurrences.ts), and the event handed back
 * carries the next occurrence's time; one row is still one candidate, so a
 * lesson that fills the year does not crowd out a differently-named match.
 */
export async function findEventByTitle(
  db: ServiceScope['db'],
  familyId: string,
  title: string,
  nowIso: string,
  timezone = 'UTC',
): Promise<ServiceResult<ResolvedEvent>> {
  const needle = title.trim();
  if (!needle) return fail('Which event? Give me its name.', { code: SERVICE_CODES.invalidInput });

  const tz = isValidTimezone(timezone) ? timezone : 'UTC';
  const bounds = instantCalendarBounds(nowIso, new Date(Date.parse(nowIso) + SEARCH_SERIES_HORIZON_MS - 1).toISOString(), tz);
  const res = await readCalendarOccurrences(db, familyId, bounds, tz, {
    columns: ['id', 'title', 'starts_at', 'family_id'],
    singlesFilter: calendarOpenWindowFilter(bounds),
    singlesLimit: RSVP_TITLE_CANDIDATES,
    refine: (query) => query.ilike('title', `%${escapeLike(needle)}%`),
  });
  if (res.error) {
    console.error('[service:calendar] rsvp event lookup failed', res.error);
    return fail(describeDbError(res.error, 'Could not look up that event.'), { code: SERVICE_CODES.db });
  }

  // Soonest first, one entry per row: a series' first occurrence stands for it.
  const nextById = new Map<string, ResolvedEvent>();
  for (const row of res.data) {
    if (!nextById.has(row.id)) nextById.set(row.id, { id: row.id, title: row.title, starts_at: row.starts_at, family_id: row.family_id });
  }
  const upcoming = [...nextById.values()].slice(0, RSVP_TITLE_CANDIDATES);
  if (!upcoming.length) {
    // Deliberately not falling back to a past event: answering for something
    // that already happened is never what was asked, and reporting it as done
    // is worse than saying so.
    return fail(`No upcoming event matching "${needle}" — it may have already happened.`, { code: SERVICE_CODES.notFound });
  }

  const distinct = [...new Set(upcoming.map((e) => e.title.trim().toLowerCase()))];
  if (distinct.length > 1) {
    const names = [...new Set(upcoming.map((e) => e.title.trim()))].slice(0, 3).map((t) => `"${t}"`).join(', ');
    return fail(`"${needle}" matches more than one thing — ${names}. Which one?`, { code: SERVICE_CODES.invalidInput });
  }
  return ok(upcoming[0]);
}

export type RsvpInput = {
  eventId?: string | null;
  eventTitle?: string | null;
  status: string;
};

/**
 * Record the ACTING person's response to an event.
 *
 * `member_id` comes from `scope.memberId` and from nowhere else. That is a
 * security property here, not tidiness: `0047`'s policy is
 * `FOR ALL … USING (is_family_member(family_id))` with no member predicate at
 * all, so the database will happily let any member write any other member's
 * row. The app is the only thing standing between a teen and an RSVP recorded
 * in a parent's name, which is what happened once already when this code used
 * `members[0]` as though it were a lookup.
 *
 * That is also why this tool could not ship until the approval row recorded WHO
 * ASKED. An approved RSVP is replayed by `performApproved`, which used to run
 * under the APPROVER's scope — so answering from `scope.memberId` would have
 * recorded the parent as going and, because `event_rsvps_once` makes the write
 * an upsert, replaced their own earlier reply. `scopeForApprovedWork` now hands
 * the replay the asker's scope, and clears `memberId` outright when the asker
 * cannot be resolved so the refusal below fires instead of a wrong answer.
 */
export async function rsvpToEvent(scope: ServiceScope, input: RsvpInput): Promise<ServiceResult<EventRsvp & { event_title: string; label: string }>> {
  const status = RSVP_STATUSES.find((s) => s === input.status?.trim());
  if (!status) return fail('An RSVP is accepted, maybe or declined.', { code: SERVICE_CODES.invalidInput });

  if (!scope.memberId) {
    return fail('Bubaly could not tell whose reply this is, so it did not answer for anyone.', { code: SERVICE_CODES.denied });
  }

  const byId = input.eventId?.trim() || null;
  const byTitle = input.eventTitle?.trim() || null;
  if (byId && byTitle) return fail('Name the event by id or by title, not both.', { code: SERVICE_CODES.invalidInput });
  if (!byId && !byTitle) return fail('Which event is this a reply to?', { code: SERVICE_CODES.invalidInput });

  let event: ResolvedEvent;
  if (byId) {
    const { data, error } = await scope.db
      .from('calendar_events')
      .select('id, title, starts_at, family_id')
      .eq('id', byId)
      .eq('family_id', scope.familyId)
      .maybeSingle();
    if (error) {
      console.error('[service:calendar] rsvp event read failed', error);
      return fail(describeDbError(error, 'Could not look up that event.'), { code: SERVICE_CODES.db });
    }
    if (!data) return fail('That event could not be found.', { code: SERVICE_CODES.notFound });
    event = data as ResolvedEvent;
  } else {
    const found = await findEventByTitle(scope.db, scope.familyId, byTitle as string, scopeNow(scope).toISOString(), scope.tz);
    if (!found.ok) return found;
    event = found.data;
  }

  // family_id is taken from the EVENT, never from the caller: nothing in the
  // schema forces `event_rsvps.family_id` to match the event's, and the row is
  // only ever read back through a family filter.
  const { data, error } = await scope.db
    .from('event_rsvps')
    .upsert(
      { event_id: event.id, family_id: event.family_id, member_id: scope.memberId, status },
      { onConflict: 'event_id,member_id' },
    )
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:calendar] rsvp write failed', error);
    return fail(describeDbError(error, 'Could not save that RSVP.'), { code: SERVICE_CODES.db });
  }

  await recordActivitySafely(scope, {
    agent: 'calendar',
    action: 'rsvp',
    title: `Replied "${RSVP_LABELS[status]}" to "${event.title}"`,
    detail: event.starts_at,
    href: '/dashboard/calendar',
    memberId: scope.memberId,
  });
  return ok({ ...data, event_title: event.title, label: RSVP_LABELS[status] });
}
