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
import {
  createEvent, deleteEvent, findConflicts, findFreeSlots, busyEvenings, rescheduleAfter, rsvpToEvent, searchEvents, updateEvent,
} from '@/lib/services/calendar';
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
  /** Pre-rendered in the family's timezone so every surface says the same words. */
  when: z.string(),
});

const slotOutput = z.object({
  slots: z.array(z.object({ starts_at: z.string(), ends_at: z.string(), when: z.string() })),
});

export const calendarTools: ToolDefinition[] = [
  defineTool({
    name: 'calendar.createEvent',
    aliases: ['create_calendar_event', 'add_calendar_event'],
    description: 'Add an event to the family calendar. Times are ISO 8601 in the family timezone.',
    domain: 'calendar',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    // The service records its own activity line with calendar-specific copy.
    activityFrom: 'service',
    input: z.object({
      title: z.string().describe('What the event is'),
      starts_at: z.string().describe('ISO 8601 start, e.g. 2026-09-12T09:00:00'),
      ends_at: z.string().nullish().describe('ISO 8601 end; omit for a one-hour default'),
      all_day: z.boolean().nullish(),
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
          ? `all day ${describeWhen(event.starts_at, scope.tz, scopeNow(scope))}`
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
        when: describeWhen(event.starts_at, scope.tz, scopeNow(scope)),
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
      starts_at: z.string().describe('New ISO 8601 start time'),
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
        when: describeWhen(event.starts_at, scope.tz, scopeNow(scope)),
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
      const moved = Boolean(data) && Date.parse(data!.starts_at) === Date.parse(input.starts_at);
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
    description: 'List calendar events in a window, soonest first.',
    domain: 'calendar',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      from: z.string().nullish().describe('ISO 8601 start of the window; defaults to now'),
      to: z.string().nullish().describe('ISO 8601 end of the window'),
      query: z.string().nullish().describe('Match against the event title'),
      assignee: z.string().nullish(),
      assignee_id: z.string().nullish(),
      limit: z.number().int().nullish(),
    }),
    output: z.object({ events: z.array(eventOutput) }),
    summarize: (_input, output) => (output.events.length === 0
      ? 'Nothing on the calendar for that window'
      : `Found ${plural(output.events.length, 'event')}, starting with ${output.events[0].title} at ${output.events[0].when}`),
    execute: async (scope, input) => {
      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;

      const res = await searchEvents(scope, {
        from: input.from ?? null,
        to: input.to ?? null,
        query: input.query ?? null,
        assigneeId: assignee.data,
        limit: input.limit ?? undefined,
      });
      if (!res.ok) return res;
      const now = scopeNow(scope);
      return ok({
        events: res.data.map((event) => ({
          id: event.id, title: event.title, starts_at: event.starts_at, ends_at: event.ends_at,
          all_day: event.all_day, category: event.category, location: event.location, assignee_id: event.assignee_id,
          when: describeWhen(event.starts_at, scope.tz, now),
        })),
      });
    },
  }),

  defineTool({
    name: 'calendar.findConflicts',
    aliases: ['find_calendar_conflicts', 'check_conflicts'],
    description: 'Find double-bookings: one person with two overlapping events.',
    domain: 'calendar',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ from: z.string().nullish(), to: z.string().nullish() }),
    output: z.object({
      conflicts: z.array(z.object({
        member_id: z.string().nullable(),
        event_ids: z.array(z.string()),
        titles: z.array(z.string()),
        when: z.string(),
      })),
    }),
    summarize: (_input, output) => (output.conflicts.length === 0
      ? 'No double-bookings in that window'
      : `Found ${plural(output.conflicts.length, 'clash', 'clashes')} — first: ${output.conflicts[0].titles.join(' vs ')} ${output.conflicts[0].when}`),
    execute: async (scope, input) => {
      const res = await findConflicts(scope, { from: input.from ?? null, to: input.to ?? null });
      if (!res.ok) return res;
      const now = scopeNow(scope);
      return ok({
        conflicts: res.data.conflicts.map((conflict) => {
          const events = conflict.eventIds.map((id) => res.data.events[id]).filter(Boolean);
          return {
            member_id: conflict.assigneeId,
            event_ids: conflict.eventIds,
            titles: events.map((event) => event.title),
            when: describeWhen(conflict.startsAt, scope.tz, now),
          };
        }),
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
