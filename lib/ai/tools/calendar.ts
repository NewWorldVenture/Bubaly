import { parseExactInstant } from '@/lib/calendar/exact-instant';
// Calendar tools — the family's shared time.
//
// Input fields are snake_case and named exactly as the legacy flat tools named
// them (`starts_at`, `ends_at`, `all_day`, `assignee`), because stored
// `approval_requests.payload.args` from before the registry must keep
// executing and because the model has been prompted in that dialect for
// months. The services underneath speak camelCase; the translation happens
// here, once.
//
// Risk tiers (§12) are set by what a family would want asked about: adding an
// event is the small reversible work Bubaly should just do (low); moving or
// editing something already on the calendar affects other people's plans
// (medium); deleting is not recoverable from the UI, so it always wants a
// person (high).
import 'server-only';
import { z } from 'zod';
import { addExactMilliseconds } from '@/lib/calendar/exact-instant';
import { calendarEventDayKey } from '@/lib/calendar/event-dates';
import { CalendarConflictAdvisorySchema, CalendarConflictSubjectSchema, CalendarConflictReferenceSchema, CalendarExactIntervalSchema, validCalendarIntervalProjection } from '@/lib/ai/result-cards';
import {
  normalizeCalendarWriteInstant, createEvent, deleteEvent, findConflicts, findFreeSlots, busyEvenings, rescheduleAfter, rsvpToEvent, updateEvent,
} from '@/lib/services/calendar';
import { searchCalendarOccurrences, validateCalendarSearchWindow } from '@/lib/services/calendar/search-occurrences';
import { scopeNow } from '@/lib/services/scope';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import type { EventCategory, RecurrenceFreq } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { resolveAssigneeId } from './family';
import { defineTool, describeWhen, plural, type ToolDefinition } from './types';

const CATEGORIES = ['general', 'school', 'sports', 'appointment', 'medication', 'maintenance', 'birthday', 'holiday', 'other'] as const;
const RECURRENCES = ['none', 'daily', 'weekly', 'monthly', 'yearly'] as const;

const eventOutput = z.object({
  id: z.string(),
  title: z.string(),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  all_day: z.boolean(),
  category: z.string(),
  location: z.string().nullable(),
  assignee_id: z.string().nullable(),
  /** Civil DATE for all-day events; family timezone for timed events. */
  when: z.string(),
});

const slotOutput = z.object({
  slots: z.array(z.object({ starts_at: z.string(), ends_at: z.string(), when: z.string() })),
});

// Search has a separate wire contract: a source occurrence is never an action ID.
const searchOccurrenceFields = {
  occurrenceKey: z.string().min(1).max(65_536),
  reference: CalendarConflictReferenceSchema,
  title: z.string().nullable(), description: z.string().nullable(), location: z.string().nullable(),
  starts_at: z.string().datetime({ offset: true }), ends_at: z.string().datetime({ offset: true }).nullable(),
  all_day: z.boolean(), actualStartsAt: z.string().datetime({ offset: true }),
  actualEndsAt: z.string().datetime({ offset: true }).nullable(),
  startDate: z.string().nullable(), endDate: z.string().nullable(),
  transparency: z.enum(['opaque', 'transparent']), occupied: z.boolean(), point: z.boolean(), estimatedEnd: z.boolean(),
  interval: z.object({ start: z.number().finite(), end: z.number().finite() }).strict(),
  exactInterval: CalendarExactIntervalSchema.optional(),
  displayOrder: z.number().int().nonnegative(), when: z.string(),
};
const nativeSearchOutput = z.object({
  ...searchOccurrenceFields, kind: z.literal('native'), id: z.string().uuid(), eventId: z.string().uuid(),
  title: z.string(), category: z.string(), assignee_id: z.string().nullable(),
  feed_id: z.string().nullable(), external_uid: z.string().nullable(),
  readOnly: z.boolean(), mutable: z.boolean(),
}).passthrough().refine(row => row.reference.kind === 'native' && row.id === row.eventId && row.id === row.reference.eventId
  && row.readOnly === (row.feed_id !== null || row.external_uid !== null) && row.mutable === !row.readOnly && validCalendarIntervalProjection(row), 'Invalid native search provenance');
const sourceSearchOutput = z.object({
  ...searchOccurrenceFields, kind: z.literal('source'), readOnly: z.literal(true), mutable: z.literal(false),
}).strict().refine(row => row.reference.kind === 'source' && validCalendarIntervalProjection(row), 'Invalid source search provenance');
const searchOutput = z.object({
  events: z.array(nativeSearchOutput), source_events: z.array(sourceSearchOutput),
  matchedCount: z.number().int().nonnegative(), totalVisibleCount: z.number().int().nonnegative(),
  returnedCount: z.number().int().nonnegative(), truncated: z.boolean(), horizonEndsAt: z.string().datetime({ offset: true }),
  filterScope: z.object({ native: z.literal('requested-filters'), sources: z.literal('unmapped-family-context'), sourceMemberCategoryMatched: z.literal(false) }).strict(),
  window: z.object({ from: z.string(), to: z.string(), bounded: z.literal(true), defaultedFrom: z.boolean(), defaultedTo: z.boolean() }).strict(),
}).strict().refine(row => row.returnedCount === row.events.length + row.source_events.length
  && row.matchedCount >= row.returnedCount && row.totalVisibleCount >= row.matchedCount
  && row.truncated === (row.matchedCount > row.returnedCount), 'Invalid search counts');

export const calendarTools: ToolDefinition[] = [
  defineTool({
    name: 'calendar.createEvent',
    aliases: ['create_calendar_event', 'add_calendar_event'],
    description: 'Add an event to the family calendar. Timed events use ISO 8601 in the family timezone. All-day events use calendar dates (YYYY-MM-DD) or UTC midnight boundaries; their end date is exclusive.',
    domain: 'calendar',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    // The service records its own activity line with calendar-specific copy.
    activityFrom: 'service',
    input: z.object({
      title: z.string().describe('What the event is'),
      starts_at: z.string().describe('Timed ISO 8601 start, e.g. 2026-09-12T09:00:00; for all_day use YYYY-MM-DD or YYYY-MM-DDT00:00:00Z'),
      ends_at: z.string().nullish().describe('Timed ISO 8601 end; omit for a one-hour default. For all_day use an exclusive later date or UTC midnight; omit for one civil day'),
      all_day: z.boolean().nullish().describe('Use calendar DATE boundaries, not floating local times, when true'),
      category: z.enum(CATEGORIES).nullish(),
      location: z.string().nullish(),
      description: z.string().nullish(),
      assignee: z.string().nullish().describe('Family member name this is for'),
      assignee_id: z.string().nullish().describe('Family member id, when already known'),
      recurrence: z.enum(RECURRENCES).nullish(),
    }),
    output: eventOutput,
    idempotencyFrom: (input) => `calendar.createEvent:${input.title.trim().toLowerCase()}:${input.starts_at}`,
    summarize: (_input, output) => `Added ${output.title} at ${output.when}`,
    resource: (output) => ({ table: 'calendar_events', id: output.id }),
    execute: async (scope, input) => {
      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;

      const res = await createEvent(scope, {
        title: input.title,
        startsAt: input.starts_at,
        endsAt: input.ends_at ?? null,
        allDay: input.all_day ?? false,
        category: (input.category ?? undefined) as EventCategory | undefined,
        location: input.location ?? null,
        description: input.description ?? null,
        assigneeId: assignee.data,
        recurrence: (input.recurrence ?? undefined) as RecurrenceFreq | undefined,
      });
      if (!res.ok) return res;

      const event = res.data;
      return ok({
        id: event.id,
        title: event.title,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        all_day: event.all_day,
        category: event.category,
        location: event.location,
        assignee_id: event.assignee_id,
        when: event.all_day
          ? `all day ${calendarEventDayKey(event, scope.tz)}`
          : describeWhen(event.starts_at, scope.tz, scopeNow(scope)),
      });
    },
    // §13: a write is not done until the row is there. Re-reading by id also
    // catches the case where RLS accepted the insert into another family.
    verify: async (scope, _input, output) => {
      const { data, error } = await scope.db
        .from('calendar_events')
        .select('id, title, starts_at')
        .eq('id', output.id)
        .eq('family_id', scope.familyId)
        .maybeSingle();
      if (error) {
        console.error('[tool:calendar.createEvent] verification read failed', error);
        return fail(describeDbError(error, 'Could not confirm the event was saved.'), { code: SERVICE_CODES.db });
      }
      if (!data) return ok({ verified: false, detail: 'The event is not on the calendar.' });
      const matches = data.title === output.title && data.starts_at === output.starts_at;
      return ok({ verified: matches, detail: matches ? `"${data.title}" is on the calendar at ${output.when}.` : 'The saved event does not match what was requested.' });
    },
  }),

  defineTool({
    name: 'calendar.updateEvent',
    aliases: ['update_calendar_event', 'edit_calendar_event'],
    description: 'Change an existing calendar event. Only the fields you pass are changed.',
    domain: 'calendar',
    capability: 'edit',
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      event_id: z.string().describe('The id of the event to change'),
      title: z.string().nullish(),
      starts_at: z.string().nullish(),
      ends_at: z.string().nullish(),
      all_day: z.boolean().nullish(),
      category: z.enum(CATEGORIES).nullish(),
      location: z.string().nullish(),
      description: z.string().nullish(),
      assignee: z.string().nullish(),
      assignee_id: z.string().nullish(),
    }),
    output: eventOutput,
    summarize: (_input, output) => `Updated ${output.title} — now ${output.when}`,
    consequences: (input) => [`Changes the calendar event ${input.event_id} for everyone in the family.`],
    resource: (output) => ({ table: 'calendar_events', id: output.id }),
    execute: async (scope, input) => {
      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;

      const res = await updateEvent(scope, input.event_id, {
        ...(input.title != null ? { title: input.title } : {}),
        ...(input.starts_at != null ? { startsAt: input.starts_at } : {}),
        ...(input.ends_at !== undefined ? { endsAt: input.ends_at } : {}),
        ...(input.all_day != null ? { allDay: input.all_day } : {}),
        ...(input.category != null ? { category: input.category as EventCategory } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(assignee.data !== null ? { assigneeId: assignee.data } : {}),
      });
      if (!res.ok) return res;
      const event = res.data;
      return ok({
        id: event.id, title: event.title, starts_at: event.starts_at, ends_at: event.ends_at,
        all_day: event.all_day, category: event.category, location: event.location, assignee_id: event.assignee_id,
        when: event.all_day ? `all day ${calendarEventDayKey(event, scope.tz)}` : describeWhen(event.starts_at, scope.tz, scopeNow(scope)),
      });
    },
  }),

  defineTool({
    name: 'calendar.rescheduleEvent',
    aliases: ['reschedule_event', 'move_calendar_event'],
    description: 'Move an event to a new start time, keeping how long it lasts.',
    domain: 'calendar',
    capability: 'edit',
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      event_id: z.string(),
      starts_at: z.string().describe('New timed ISO 8601 start; for an all-day event use YYYY-MM-DD or UTC midnight'),
    }),
    output: eventOutput,
    summarize: (_input, output) => `Moved ${output.title} to ${output.when}`,
    consequences: (input) => [`Moves calendar event ${input.event_id}; anyone counting on the old time needs to know.`],
    resource: (output) => ({ table: 'calendar_events', id: output.id }),
    execute: async (scope, input) => {
      const res = await rescheduleAfter(scope, input.event_id, { startsAt: input.starts_at });
      if (!res.ok) return res;
      const event = res.data;
      return ok({
        id: event.id, title: event.title, starts_at: event.starts_at, ends_at: event.ends_at,
        all_day: event.all_day, category: event.category, location: event.location, assignee_id: event.assignee_id,
        when: event.all_day ? `all day ${calendarEventDayKey(event, scope.tz)}` : describeWhen(event.starts_at, scope.tz, scopeNow(scope)),
      });
    },
    verify: async (scope, input, output) => {
      const { data, error } = await scope.db
        .from('calendar_events')
        .select('id, starts_at')
        .eq('id', output.id)
        .eq('family_id', scope.familyId)
        .maybeSingle();
      if (error) {
        console.error('[tool:calendar.rescheduleEvent] verification read failed', error);
        return fail(describeDbError(error, 'Could not confirm the new time was saved.'), { code: SERVICE_CODES.db });
      }
      let moved = false;
      try { const expected = normalizeCalendarWriteInstant(input.starts_at, scope.tz); moved = Boolean(data) && expected !== null && parseExactInstant(data!.starts_at) === parseExactInstant(expected); } catch { /* Invalid receipts cannot verify a move. */ }
      return ok({ verified: moved, detail: moved ? `${output.title} now starts at ${output.when}.` : 'The event did not move.' });
    },
  }),

  defineTool({
    name: 'calendar.deleteEvent',
    aliases: ['delete_calendar_event', 'cancel_calendar_event'],
    description: 'Remove an event from the family calendar. This cannot be undone.',
    domain: 'calendar',
    capability: 'delete',
    risk: 'high',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({ event_id: z.string() }),
    output: z.object({ id: z.string(), title: z.string() }),
    summarize: (_input, output) => `Removed ${output.title} from the calendar`,
    consequences: (input) => [
      `Permanently deletes calendar event ${input.event_id}.`,
      'Anyone who was counting on it will simply stop seeing it — there is no undo.',
    ],
    resource: (output) => ({ table: 'calendar_events', id: output.id }),
    execute: async (scope, input) => {
      const res = await deleteEvent(scope, input.event_id);
      if (!res.ok) return res;
      return ok({ id: res.data.id, title: res.data.title });
    },
  }),

  defineTool({
    name: 'calendar.searchEvents',
    aliases: ['list_upcoming_events', 'search_calendar'],
    description: 'List native calendar events and read-only imported family context in a bounded window, soonest first. Free annotations and points are visible but do not occupy time. Omitted end defaults to a finite 366-day horizon.',
    domain: 'calendar',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      from: z.string().nullish().describe('ISO 8601 start with explicit Z or numeric UTC offset; defaults to now'),
      to: z.string().nullish().describe('ISO 8601 inclusive end with explicit Z or numeric UTC offset; defaults to 366 days after the start'),
      query: z.string().nullish().describe('Match against the event title'),
      assignee: z.string().nullish(),
      assignee_id: z.string().nullish(),
      category: z.enum(CATEGORIES).nullish(),
      limit: z.number().int().nullish(),
    }),
    output: searchOutput,
    summarize: (input, output) => {
      const rows = [...output.events, ...output.source_events].sort((a, b) => a.displayOrder - b.displayOrder);
      const annotations = rows.filter(row => !row.occupied).length;
      const filtered = input.assignee != null || input.assignee_id != null || input.category != null;
      const parts = rows.length === 0 ? ['No calendar results in this bounded window']
        : filtered ? [`Found ${plural(output.events.length, 'event')} matching the native filters and ${plural(output.source_events.length, 'imported family context item')} (person/category unmapped)`]
        : [`Found ${plural(rows.length, 'event')}, starting with ${rows[0].title ?? 'Calendar event'} at ${rows[0].when}`];
      if (annotations) parts.push(`${plural(rows.length - annotations, 'occupied event')} and ${plural(annotations, 'free or point annotation')} shown; annotations do not occupy time`);
      if (output.truncated) parts.push(`Showing ${output.returnedCount} of ${output.matchedCount} visible results`);
      if (output.window.defaultedFrom || output.window.defaultedTo) parts.push(`Bounded search from ${output.window.from} through ${output.horizonEndsAt}`);
      return parts.join('. ');
    },
    execute: async (scope, input) => {
      const now = scopeNow(scope);
      const from = input.from ?? now.toISOString();
      let window: ReturnType<typeof validateCalendarSearchWindow>;
      try {
        const to = input.to ?? addExactMilliseconds(from, 366 * 86_400_000 - 1);
        window = validateCalendarSearchWindow(scope, { from, to });
      } catch {
        return fail('Choose a valid bounded calendar window and household timezone.', { code: SERVICE_CODES.invalidInput });
      }
      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;

      const res = await searchCalendarOccurrences(scope, {
        from: window.from, to: window.to,
        query: input.query ?? undefined,
        assigneeId: assignee.data ?? undefined,
        category: input.category ?? undefined,
        limit: input.limit ?? undefined,
      });
      if (!res.ok) return res;
      return ok({
        ...res.data,
        events: res.data.events.map(event => ({ ...event, when: event.all_day
          ? `all day ${event.startDate} through ${event.endDate} (exclusive)`
          : describeWhen(event.actualStartsAt, scope.tz, now) })),
        source_events: res.data.source_events.map(event => ({ ...event, when: event.all_day
          ? `all day ${event.startDate} through ${event.endDate} (exclusive)`
          : describeWhen(event.actualStartsAt, scope.tz, now) })),
        window: { from: window.from, to: window.to, bounded: true as const,
          defaultedFrom: input.from == null, defaultedTo: input.to == null },
      });
    },
  }),

  defineTool({
    name: 'calendar.findConflicts',
    aliases: ['find_calendar_conflicts', 'check_conflicts'],
    description: 'Find personal double-bookings and conservative family overlaps involving imported calendars.',
    domain: 'calendar',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ from: z.string().nullish(), to: z.string().nullish() }),
    output: z.object({
      conflicts: z.array(z.object({
        kind: z.literal('personal'),
        member_id: z.string().nullable(),
        event_ids: z.array(z.string()),
        titles: z.array(z.string()),
        when: z.string(),
        occurrenceKeys: z.array(z.string()),
        references: z.array(CalendarConflictReferenceSchema),
        subjects: z.array(CalendarConflictSubjectSchema),
      })),
      advisories: z.array(CalendarConflictAdvisorySchema),
    }),
    summarize: (_input, output) => (output.advisories.length > 0
      ? `${plural(output.conflicts.length, 'personal clash', 'personal clashes')} and ${plural(output.advisories.length, 'family calendar overlap')} in that window`
      : output.conflicts.length === 0
      ? 'No double-bookings in that window'
      : `Found ${plural(output.conflicts.length, 'clash', 'clashes')} — first: ${output.conflicts[0].titles.join(' vs ')} ${output.conflicts[0].when}`),
    execute: async (scope, input) => {
      const res = await findConflicts(scope, { from: input.from ?? null, to: input.to ?? null });
      if (!res.ok) return res;
      const now = scopeNow(scope);
      return ok({
        conflicts: res.data.conflicts.map((conflict) => {
          const subjects = (conflict.occurrenceKeys ?? []).map(key => res.data.subjects[key]);
          return {
            kind: 'personal' as const,
            occurrenceKeys: conflict.occurrenceKeys ?? [],
            references: conflict.references ?? [],
            subjects,
            member_id: conflict.assigneeId,
            event_ids: conflict.eventIds,
            titles: subjects.map(subject => subject.title ?? 'Calendar event'),
            when: describeWhen(conflict.startsAt, scope.tz, now),
          };
        }),
        advisories: res.data.advisories.map(advisory => ({ ...advisory, when: describeWhen(advisory.startsAt, scope.tz, now) })),
      });
    },
  }),

  defineTool({
    name: 'calendar.findFreeSlots',
    aliases: ['find_free_time', 'find_availability'],
    description: 'Find times when nobody has a commitment, across calendar, school and sports events.',
    domain: 'scheduling',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      duration_min: z.number().int().describe('How long the slot needs to be, in minutes'),
      from: z.string().nullish(),
      to: z.string().nullish(),
      member_ids: z.array(z.string()).nullish().describe('Only these people need to be free; omit for the whole family'),
      start_hour: z.number().int().nullish().describe('Earliest local hour to suggest, 0-23. Defaults to 8'),
      end_hour: z.number().int().nullish().describe('Latest local hour to suggest, 0-23. Defaults to 21'),
      limit: z.number().int().nullish(),
    }),
    output: slotOutput,
    summarize: (input, output) => (output.slots.length === 0
      ? `No ${input.duration_min}-minute openings in that window`
      : `Found ${plural(output.slots.length, 'opening')} — earliest ${output.slots[0].when}`),
    execute: async (scope, input) => {
      const res = await findFreeSlots(scope, {
        durationMin: input.duration_min,
        from: input.from ?? null,
        to: input.to ?? null,
        memberIds: input.member_ids ?? undefined,
        workingHours: input.start_hour != null || input.end_hour != null
          ? { startHour: input.start_hour ?? 8, endHour: input.end_hour ?? 21 }
          : undefined,
        limit: input.limit ?? undefined,
      });
      if (!res.ok) return res;
      const now = scopeNow(scope);
      return ok({
        slots: res.data.map((slot) => ({
          starts_at: slot.startsAt, ends_at: slot.endsAt, when: describeWhen(slot.startsAt, scope.tz, now),
        })),
      });
    },
  }),

  defineTool({
    name: 'calendar.busyEvenings',
    aliases: ['busy_evenings'],
    description: 'Which evenings in a window already have something on them — the input meal planning needs.',
    domain: 'scheduling',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      from: z.string().nullish(),
      to: z.string().nullish(),
      evening_from_hour: z.number().int().nullish().describe('Local hour an evening starts. Defaults to 17'),
    }),
    output: z.object({ busy_days: z.array(z.string()).describe('Family-local YYYY-MM-DD keys') }),
    summarize: (_input, output) => (output.busy_days.length === 0
      ? 'Every evening in that window is clear'
      : `${plural(output.busy_days.length, 'evening')} already booked: ${output.busy_days.join(', ')}`),
    execute: async (scope, input) => {
      const res = await busyEvenings(scope, {
        from: input.from ?? null,
        to: input.to ?? null,
        eveningFromHour: input.evening_from_hour ?? undefined,
      });
      if (!res.ok) return res;
      return ok({ busy_days: res.data });
    },
  }),

  defineTool({
    name: 'calendar.rsvp',
    aliases: ['rsvp_to_event'],
    description: "Record the asking person's own reply to an event: going, maybe, or can't make it.",
    domain: 'calendar',
    capability: 'edit',
    // See lib/ai/tools/notes.ts: before this tool existed, lib/trust/ai-gate.ts
    // used its hard-coded `medium` fallback for `rsvp_to_event`. Declaring
    // anything else here would silently move the chat gate for children.
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      // Preferred, and what every other calendar write takes. A plan step can
      // get one from `calendar.searchEvents`.
      event_id: z.string().nullish().describe('The event id, when it is known'),
      // Kept because stored approval payloads from the chat tool carry a title
      // and nothing else, and those rows must still execute when a parent
      // approves them. The service resolves it to the NEXT matching occurrence
      // and refuses a genuinely ambiguous name rather than guessing.
      event_title: z.string().nullish().describe('Part of the event name, when the id is not known'),
      status: z.enum(['accepted', 'maybe', 'declined']),
    }),
    output: z.object({
      id: z.string(),
      event_id: z.string(),
      status: z.string(),
      event_title: z.string(),
      label: z.string(),
    }),
    // The upsert is idempotent by construction: `event_rsvps_once UNIQUE
    // (event_id, member_id)` (0047) means a repeat writes the same one row.
    idempotencyFrom: () => null,
    summarize: (_input, output) => `Replied "${output.label}" to "${output.event_title}"`,
    resource: (output) => ({ table: 'event_rsvps', id: output.id }),
    execute: async (scope, input) => {
      const res = await rsvpToEvent(scope, {
        eventId: input.event_id ?? null,
        eventTitle: input.event_title ?? null,
        status: input.status,
      });
      if (!res.ok) return res;
      return {
        ok: true,
        data: {
          id: res.data.id,
          event_id: res.data.event_id,
          status: res.data.status,
          event_title: res.data.event_title,
          label: res.data.label,
        },
      };
    },
  }),
];
