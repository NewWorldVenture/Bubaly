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
import { freeGaps, mergeIntervals, type Interval } from '@/lib/calendar/scheduling';
import type { EventCategory, Insertable, RecurrenceFreq, Tables, Updatable } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { settleAll } from '@/lib/supabase/settle';
import { recordActivitySafely } from '../activity';
import { keyedProbe, makeKey, withIdempotency } from '../idempotency';
import { dayKeyInTz, dayKeysBetween, scopeNow, zonedTimeMs } from '../scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

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

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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

/**
 * Create an event.
 *
 * `calendar_events.created_by` references `auth.users` (0002), so the auth user
 * id is correct here — unlike `todo_lists`/`todo_items`, which reference
 * `family_members`. Each service resolves this per column against the
 * migration that created the table; the two are not interchangeable.
 */
export async function createEvent(scope: ServiceScope, input: CreateEventInput): Promise<ServiceResult<CalendarEvent>> {
  const title = input.title?.trim() ?? '';
  if (!title) return fail('An event needs a title.', { code: SERVICE_CODES.invalidInput });

  const startsAt = isoOrNull(input.startsAt);
  if (!startsAt) return fail('That start time could not be understood.', { code: SERVICE_CODES.invalidInput });

  const endsAt = isoOrNull(input.endsAt);
  if (endsAt && Date.parse(endsAt) < Date.parse(startsAt)) {
    return fail('An event cannot end before it starts.', { code: SERVICE_CODES.invalidInput });
  }

  const category = input.category && CATEGORIES.includes(input.category) ? input.category : 'general';
  const recurrence = input.recurrence && RECURRENCES.includes(input.recurrence) ? input.recurrence : 'none';

  return withIdempotency<CalendarEvent>(
    scope,
    {
      operation: 'calendar.createEvent',
      input: { title, startsAt, allDay: input.allDay ?? false },
      // 0256's `idempotency_key` + partial unique index: the retried call finds
      // its own row rather than a coincidence, and two retries racing cannot
      // both insert.
      find: keyedProbe(scope, 'calendar_events', 'event'),
    },
    async (key) => {
      const { data, error } = await scope.db
        .from('calendar_events')
        .insert({
          family_id: scope.familyId,
          title,
          description: input.description?.trim() || null,
          location: input.location?.trim() || null,
          category,
          starts_at: startsAt,
          ends_at: endsAt,
          all_day: input.allDay ?? false,
          recurrence,
          recurrence_until: isoOrNull(input.recurrenceUntil),
          assignee_id: input.assigneeId ?? null,
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
    const startsAt = isoOrNull(input.startsAt);
    if (!startsAt) return fail('That start time could not be understood.', { code: SERVICE_CODES.invalidInput });
    const endsAt = isoOrNull(input.endsAt);
    if (endsAt && Date.parse(endsAt) < Date.parse(startsAt)) {
      return fail('An event cannot end before it starts.', { code: SERVICE_CODES.invalidInput });
    }
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
      recurrence_until: isoOrNull(input.recurrenceUntil),
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
    .select('id, title');
  if (error) {
    console.error('[service:calendar] batch delete failed', error);
    return fail(describeDbError(error, 'Could not undo those events.'), { code: SERVICE_CODES.db });
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

export async function updateEvent(scope: ServiceScope, eventId: string, patch: UpdateEventPatch): Promise<ServiceResult<CalendarEvent>> {
  const update: Updatable<'calendar_events'> = {};

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) return fail('An event needs a title.', { code: SERVICE_CODES.invalidInput });
    update.title = title;
  }
  if (patch.startsAt !== undefined) {
    const startsAt = isoOrNull(patch.startsAt);
    if (!startsAt) return fail('That start time could not be understood.', { code: SERVICE_CODES.invalidInput });
    update.starts_at = startsAt;
  }
  if (patch.endsAt !== undefined) update.ends_at = isoOrNull(patch.endsAt);
  if (patch.allDay !== undefined) update.all_day = patch.allDay;
  if (patch.location !== undefined) update.location = patch.location?.trim() || null;
  if (patch.description !== undefined) update.description = patch.description?.trim() || null;
  if (patch.assigneeId !== undefined) update.assignee_id = patch.assigneeId;
  if (patch.category !== undefined && CATEGORIES.includes(patch.category)) update.category = patch.category;
  if (patch.recurrence !== undefined && RECURRENCES.includes(patch.recurrence)) update.recurrence = patch.recurrence;
  if (patch.recurrenceUntil !== undefined) update.recurrence_until = isoOrNull(patch.recurrenceUntil);

  if (Object.keys(update).length === 0) {
    return fail('Nothing to change on that event.', { code: SERVICE_CODES.invalidInput });
  }

  // The same range check `createEvent` makes, for the edit that used to have it
  // only in the browser. Deliberately limited to a patch carrying BOTH sides —
  // which is what the edit modal sends, since it renders both fields — because
  // cross-checking a patch that moves only the end would mean reading the row
  // first, an extra round trip on every edit to guard a shape no caller sends.
  if (update.starts_at && update.ends_at && Date.parse(update.ends_at) < Date.parse(update.starts_at)) {
    return fail('An event cannot end before it starts.', { code: SERVICE_CODES.invalidInput });
  }

  const { data, error } = await scope.db
    .from('calendar_events')
    .update(update)
    .eq('id', eventId)
    .eq('family_id', scope.familyId)
    .select('*')
    .maybeSingle();

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
};

/** Events in a window, soonest first. The default window is open-ended forward. */
export async function searchEvents(scope: ServiceScope, input: SearchEventsInput = {}): Promise<ServiceResult<CalendarEvent[]>> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  let query = scope.db
    .from('calendar_events')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('starts_at', { ascending: true })
    .limit(limit);

  const from = isoOrNull(input.from) ?? scopeNow(scope).toISOString();
  query = query.gte('starts_at', from);
  const to = isoOrNull(input.to);
  if (to) query = query.lte('starts_at', to);
  if (input.assigneeId) query = query.eq('assignee_id', input.assigneeId);
  if (input.categories?.length) query = query.in('category', input.categories);
  if (input.query?.trim()) {
    // Escape the PostgREST pattern wildcards so a title containing '%' does not
    // silently widen the search.
    const term = input.query.trim().replace(/[%_]/g, (m) => `\\${m}`);
    query = query.ilike('title', `%${term}%`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[service:calendar] search failed', error);
    return fail(describeDbError(error, 'Could not load the calendar.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

/**
 * Double-bookings in a window: one person, two overlapping timed events.
 * All-day and unassigned events are excluded by `detectConflicts` because they
 * are not a personal clash.
 */
export async function findConflicts(
  scope: ServiceScope,
  input: { from?: string | null; to?: string | null } = {},
): Promise<ServiceResult<{ conflicts: EventConflict[]; events: Record<string, CalendarEvent> }>> {
  const events = await searchEvents(scope, { from: input.from, to: input.to, limit: 200 });
  if (!events.ok) return events;

  const conflictEvents: ConflictEvent[] = events.data.map((e) => ({
    id: e.id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, all_day: e.all_day, assignee_id: e.assignee_id,
  }));
  const byId = Object.fromEntries(events.data.map((e) => [e.id, e]));
  return ok({ conflicts: detectConflicts(conflictEvents, DEFAULT_DURATION_MIN), events: byId });
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
  const durationMin = Math.max(Math.round(input.durationMin), 5);
  if (!Number.isFinite(durationMin)) return fail('That duration could not be understood.', { code: SERVICE_CODES.invalidInput });

  const now = scopeNow(scope);
  const fromMs = Date.parse(isoOrNull(input.from) ?? now.toISOString());
  const toMs = Date.parse(isoOrNull(input.to) ?? new Date(fromMs + 7 * 24 * 3600_000).toISOString());
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return fail('That search window could not be understood.', { code: SERVICE_CODES.invalidInput });
  }

  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  const members = input.memberIds?.filter(Boolean) ?? [];

  const [calendar, school, sports] = await settleAll([
    scope.db.from('calendar_events').select('starts_at, ends_at, all_day, assignee_id')
      .eq('family_id', scope.familyId).gte('starts_at', fromIso).lte('starts_at', toIso),
    scope.db.from('school_events').select('starts_at, ends_at, member_id')
      .eq('family_id', scope.familyId).gte('starts_at', fromIso).lte('starts_at', toIso),
    scope.db.from('sports_events').select('starts_at, ends_at, member_id')
      .eq('family_id', scope.familyId).gte('starts_at', fromIso).lte('starts_at', toIso),
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
  const push = (startsAt: string, endsAt: string | null, allDay: boolean) => {
    const start = Date.parse(startsAt);
    if (!Number.isFinite(start)) return;
    if (allDay) {
      // An all-day row blocks the family-local day it falls on, not a UTC day.
      const key = dayKeyInTz(new Date(start), scope.tz);
      const dayStart = zonedTimeMs(key, 0, 0, scope.tz);
      busy.push({ start: dayStart, end: dayStart + 24 * 3600_000 });
      return;
    }
    const parsedEnd = endsAt ? Date.parse(endsAt) : Number.NaN;
    const end = Number.isFinite(parsedEnd) && parsedEnd > start ? parsedEnd : start + DEFAULT_DURATION_MIN * MINUTE_MS;
    busy.push({ start, end });
  };

  for (const e of calendar.data ?? []) {
    if (members.length > 0 && e.assignee_id && !members.includes(e.assignee_id)) continue;
    push(e.starts_at, e.ends_at, e.all_day);
  }
  for (const e of school.data ?? []) {
    if (members.length > 0 && e.member_id && !members.includes(e.member_id)) continue;
    push(e.starts_at, e.ends_at, false);
  }
  for (const e of sports.data ?? []) {
    if (members.length > 0 && e.member_id && !members.includes(e.member_id)) continue;
    push(e.starts_at, e.ends_at, false);
  }

  const hours = input.workingHours ?? { startHour: 8, endHour: 21 };
  const windows: Interval[] = [];
  for (const key of dayKeysBetween(fromMs, toMs, scope.tz)) {
    const open = zonedTimeMs(key, hours.startHour, 0, scope.tz);
    const close = zonedTimeMs(key, hours.endHour, 0, scope.tz);
    const start = Math.max(open, fromMs, now.getTime());
    const end = Math.min(close, toMs);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) windows.push({ start, end });
  }

  const merged = mergeIntervals(busy);
  const durationMs = durationMin * MINUTE_MS;
  const granMs = Math.max(input.granularityMin ?? 15, 1) * MINUTE_MS;
  const limit = Math.min(Math.max(input.limit ?? 6, 1), 50);

  const slots: FreeSlot[] = [];
  for (const window of windows) {
    for (const gap of freeGaps(merged, window.start, window.end)) {
      let start = gap.start;
      const remainder = start % granMs;
      if (remainder !== 0) start += granMs - remainder;
      while (start + durationMs <= gap.end) {
        slots.push({
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + durationMs).toISOString(),
          dayKey: dayKeyInTz(new Date(start), scope.tz),
        });
        if (slots.length >= limit) return ok(slots);
        start += granMs;
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
  const now = scopeNow(scope);
  const fromMs = Date.parse(isoOrNull(input.from) ?? now.toISOString());
  const toMs = Date.parse(isoOrNull(input.to) ?? new Date(fromMs + 7 * 24 * 3600_000).toISOString());
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return fail('That window could not be understood.', { code: SERVICE_CODES.invalidInput });
  }

  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  const [calendar, sports] = await settleAll([
    scope.db.from('calendar_events').select('starts_at, all_day')
      .eq('family_id', scope.familyId).gte('starts_at', fromIso).lte('starts_at', toIso),
    scope.db.from('sports_events').select('starts_at')
      .eq('family_id', scope.familyId).gte('starts_at', fromIso).lte('starts_at', toIso),
  ]);
  if (calendar.error || sports.error) {
    console.error('[service:calendar] busy evenings read failed', calendar.error ?? sports.error);
    return fail(describeDbError(calendar.error ?? sports.error, 'Could not check the week ahead.'), { code: SERVICE_CODES.db });
  }

  const eveningHour = input.eveningFromHour ?? 17;
  const keys = new Set<string>();
  const consider = (startsAt: string, allDay: boolean) => {
    const ms = Date.parse(startsAt);
    if (!Number.isFinite(ms)) return;
    const key = dayKeyInTz(new Date(ms), scope.tz);
    // An all-day commitment consumes the evening too.
    if (allDay || ms >= zonedTimeMs(key, eveningHour, 0, scope.tz)) keys.add(key);
  };
  for (const e of calendar.data ?? []) consider(e.starts_at, e.all_day);
  for (const e of sports.data ?? []) consider(e.starts_at, false);

  return ok([...keys].sort());
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
  const startsAt = isoOrNull(input.startsAt);
  if (!startsAt) return fail('That new time could not be understood.', { code: SERVICE_CODES.invalidInput });

  const { data: existing, error: readError } = await scope.db
    .from('calendar_events')
    .select('id, title, starts_at, ends_at')
    .eq('id', eventId)
    .eq('family_id', scope.familyId)
    .maybeSingle();
  if (readError) {
    console.error('[service:calendar] reschedule read failed', readError);
    return fail(describeDbError(readError, 'Could not load that event.'), { code: SERVICE_CODES.db });
  }
  if (!existing) return fail('That event could not be found.', { code: SERVICE_CODES.notFound });

  const previousStart = Date.parse(existing.starts_at);
  const previousEnd = existing.ends_at ? Date.parse(existing.ends_at) : Number.NaN;
  const durationMs = Number.isFinite(previousEnd) && Number.isFinite(previousStart) && previousEnd > previousStart
    ? previousEnd - previousStart
    : null;

  return updateEvent(scope, eventId, {
    startsAt,
    endsAt: durationMs === null ? null : new Date(Date.parse(startsAt) + durationMs).toISOString(),
  });
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
 */
export async function findEventByTitle(
  db: ServiceScope['db'],
  familyId: string,
  title: string,
  nowIso: string,
): Promise<ServiceResult<ResolvedEvent>> {
  const needle = title.trim();
  if (!needle) return fail('Which event? Give me its name.', { code: SERVICE_CODES.invalidInput });

  const { data, error } = await db
    .from('calendar_events')
    .select('id, title, starts_at, family_id')
    .eq('family_id', familyId)
    .ilike('title', `%${needle}%`)
    .gte('starts_at', nowIso)
    .order('starts_at', { ascending: true })
    .limit(RSVP_TITLE_CANDIDATES);
  if (error) {
    console.error('[service:calendar] rsvp event lookup failed', error);
    return fail(describeDbError(error, 'Could not look up that event.'), { code: SERVICE_CODES.db });
  }

  const upcoming = (data ?? []) as ResolvedEvent[];
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
    const found = await findEventByTitle(scope.db, scope.familyId, byTitle as string, scopeNow(scope).toISOString());
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
