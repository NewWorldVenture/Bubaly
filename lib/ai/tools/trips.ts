// Trip tools — the "prepare our vacation" workflow's hands.
//
// Reads are `travel`, low risk. Writes are tiered by what a family would want
// asked about: creating a trip record or a packing list is small and easily
// undone (low); drafting a full plan spends a model call and writes dozens
// of rows (medium); putting the trip on the shared calendar shows up in
// everyone's week (medium). The services underneath are idempotent on their
// natural keys, so a retried step never produces a second itinerary or a
// second all-day event.
import 'server-only';
import { z } from 'zod';
import { scopeNow } from '@/lib/services/scope';
import {
  buildPlan, commitmentConflicts, computeReadiness, createPetCareTasks, documentsRisk, findOrCreateVacation, generatePackingList, getTrip,
  petPrep, planTripDisruption, syncToCalendar,
} from '@/lib/services/trips';
import { ok } from '@/lib/services/types';
import { resolveAssigneeId } from './family';
import { defineTool, describeDay, describeWhen, plural, type ToolDefinition } from './types';

const KINDS = ['road_trip', 'flight', 'cruise', 'theme_park', 'international', 'domestic', 'staycation', 'camping', 'other'] as const;

const tripSummary = z.object({
  id: z.string(),
  title: z.string(),
  destination: z.string().nullable(),
  kind: z.string(),
  status: z.string(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  nights: z.number().int(),
  is_international: z.boolean(),
  travelers: z.number().int(),
  counts: z.object({
    lodging: z.number().int(), flights: z.number().int(), transport: z.number().int(), activities: z.number().int(), reservations: z.number().int(),
    itinerary_items: z.number().int(), packing_items: z.number().int(), packing_packed: z.number().int(), documents: z.number().int(), emergency_contacts: z.number().int(),
  }),
  budget: z.object({ planned_cents: z.number().int(), spent_cents: z.number().int(), over: z.boolean() }),
});

const documentRisk = z.object({
  kind: z.string(), member_id: z.string().nullable(), title: z.string(), detail: z.string(), severity: z.number().int(),
});

export const tripTools: ToolDefinition[] = [
  defineTool({
    name: 'trips.getTrip',
    aliases: ['get_trip', 'get_vacation'],
    description: 'Everything on file for one trip: dates, travelers, bookings, itinerary, packing progress, documents and budget.',
    domain: 'travel',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ vacation_id: z.string() }),
    output: tripSummary,
    summarize: (_input, output) => `${output.title}${output.destination ? ` to ${output.destination}` : ''}: ${output.start_date ?? 'no dates'}${output.end_date ? ` – ${output.end_date}` : ''}, ${plural(output.travelers, 'traveler')}`,
    execute: async (scope, input) => {
      const res = await getTrip(scope, input.vacation_id);
      if (!res.ok) return res;
      const s = res.data;
      return ok({
        id: s.trip.id, title: s.trip.title, destination: s.trip.destination, kind: s.trip.kind, status: s.trip.status,
        start_date: s.trip.start_date, end_date: s.trip.end_date, nights: s.nights, is_international: s.trip.is_international,
        travelers: s.travelers.length,
        counts: {
          lodging: s.lodging.length, flights: s.flights.length, transport: s.transport.length, activities: s.activities.length, reservations: s.reservations.length,
          itinerary_items: s.items.length, packing_items: s.packingItems.length, packing_packed: s.packingItems.filter((p) => p.packed).length,
          documents: s.documents.length, emergency_contacts: s.emergencyContacts.length,
        },
        budget: { planned_cents: s.budgetSummary.planned_cents, spent_cents: s.budgetSummary.spent_cents, over: s.budgetSummary.over },
      });
    },
  }),

  defineTool({
    name: 'trips.findOrCreateVacation',
    aliases: ['find_or_create_vacation', 'create_trip'],
    description: 'Find the trip a request is about by destination or title, or create it when there is none. Dates are YYYY-MM-DD.',
    domain: 'travel',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      title: z.string().nullish(),
      destination: z.string().nullish(),
      start_date: z.string().nullish(),
      end_date: z.string().nullish(),
      kind: z.enum(KINDS).nullish(),
      is_international: z.boolean().nullish(),
      budget: z.number().nullish().describe('Whole-trip budget in dollars'),
    }),
    output: z.object({ id: z.string(), title: z.string(), destination: z.string().nullable(), start_date: z.string().nullable(), end_date: z.string().nullable(), created: z.boolean() }),
    idempotencyFrom: (input) => `trips.findOrCreateVacation:${(input.title ?? input.destination ?? '').trim().toLowerCase()}:${input.start_date ?? ''}`,
    summarize: (_input, output) => (output.created ? `Started planning ${output.title}` : `Found the existing trip ${output.title}`),
    resource: (output) => ({ table: 'vacations', id: output.id }),
    execute: async (scope, input) => {
      const res = await findOrCreateVacation(scope, {
        title: input.title ?? null, destination: input.destination ?? null, startDate: input.start_date ?? null, endDate: input.end_date ?? null,
        kind: input.kind ?? null, isInternational: input.is_international ?? null, budget: input.budget ?? null,
      });
      if (!res.ok) return res;
      const v = res.data.vacation;
      return ok({ id: v.id, title: v.title, destination: v.destination, start_date: v.start_date, end_date: v.end_date, created: res.data.created });
    },
  }),

  defineTool({
    name: 'trips.buildPlan',
    aliases: ['build_trip_plan', 'plan_vacation'],
    description: 'Draft activities, a day-by-day itinerary, a budget and a packing list for a trip. Leaves an existing plan alone unless told to rebuild.',
    domain: 'travel',
    capability: 'create',
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      vacation_id: z.string(),
      preferences: z.string().nullish().describe('What the family wants from the trip'),
      rebuild: z.boolean().nullish().describe('Replace an existing plan'),
    }),
    output: z.object({
      built: z.boolean(),
      reason: z.string().nullable(),
      added: z.object({ activities: z.number().int(), items: z.number().int(), budget: z.number().int(), packing: z.number().int() }),
    }),
    idempotencyFrom: (input) => `trips.buildPlan:${input.vacation_id}`,
    summarize: (_input, output) => (output.built
      ? `Drafted the trip: ${plural(output.added.activities, 'activity', 'activities')}, ${plural(output.added.items, 'itinerary entry', 'itinerary entries')}, ${plural(output.added.budget, 'budget line')}${output.added.packing ? `, ${plural(output.added.packing, 'packing item')}` : ''}`
      : output.reason ?? 'The trip already had a plan'),
    consequences: (input) => [
      `Adds activities, itinerary entries and budget lines to trip ${input.vacation_id ?? ''}${input.rebuild ? ', on top of the existing plan' : ''}.`,
      'Uses one model call; nothing is booked or paid for.',
    ],
    execute: async (scope, input) => {
      const res = await buildPlan(scope, input.vacation_id, { prompt: input.preferences ?? null, force: input.rebuild ?? false });
      if (!res.ok) return res;
      return ok(res.data);
    },
  }),

  defineTool({
    name: 'trips.createPackingList',
    aliases: ['create_packing_list', 'generate_packing_list'],
    description: 'Build packing lists for a trip from its type, length, weather and activities — one per traveler, or a shared master list.',
    domain: 'travel',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      vacation_id: z.string(),
      member: z.string().nullish().describe('Only this traveler'),
      member_id: z.string().nullish(),
      per_traveler: z.boolean().nullish().describe('Defaults to true'),
    }),
    output: z.object({
      lists: z.array(z.object({ list_id: z.string(), member_id: z.string().nullable(), name: z.string(), added: z.number().int(), skipped: z.number().int() })),
    }),
    idempotencyFrom: (input) => `trips.createPackingList:${input.vacation_id}:${input.member_id ?? input.member ?? 'all'}`,
    summarize: (_input, output) => {
      const added = output.lists.reduce((s, l) => s + l.added, 0);
      return added === 0
        ? 'Every packing list was already complete'
        : `Added ${plural(added, 'item')} across ${plural(output.lists.length, 'packing list')}`;
    },
    execute: async (scope, input) => {
      const member = await resolveAssigneeId(scope, { assignee: input.member, assignee_id: input.member_id });
      if (!member.ok) return member;
      const res = await generatePackingList(scope, input.vacation_id, { memberId: member.data, perTraveler: input.per_traveler ?? true });
      if (!res.ok) return res;
      return ok({ lists: res.data.lists.map((l) => ({ list_id: l.listId, member_id: l.memberId, name: l.name, added: l.added, skipped: l.skipped })) });
    },
  }),

  defineTool({
    name: 'trips.computeReadiness',
    aliases: ['trip_readiness', 'vacation_readiness'],
    description: 'Score how ready a trip is (0–100) with what to fix next, paperwork risks and the budget state.',
    domain: 'travel',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ vacation_id: z.string() }),
    output: z.object({
      trip_id: z.string(),
      title: z.string(),
      score: z.number().int(),
      level: z.string(),
      days_until: z.number().int().nullable(),
      factors: z.array(z.object({ key: z.string(), label: z.string(), score: z.number().int() })),
      recommendations: z.array(z.string()),
      document_risks: z.array(documentRisk),
      itinerary_conflicts: z.number().int(),
      budget: z.object({ planned_cents: z.number().int(), spent_cents: z.number().int(), over: z.boolean() }),
    }),
    summarize: (_input, output) => `${output.title} is ${output.score}/100 ready (${output.level.replace(/_/g, ' ')})${output.recommendations[0] ? `; next: ${output.recommendations[0]}` : ''}`,
    execute: async (scope, input) => {
      const res = await computeReadiness(scope, input.vacation_id);
      if (!res.ok) return res;
      const r = res.data;
      return ok({
        trip_id: r.tripId, title: r.title, score: r.score, level: r.level, days_until: r.daysUntil,
        factors: r.factors.map((f) => ({ key: f.key, label: f.label, score: f.score })),
        recommendations: r.recommendations,
        document_risks: r.documentRisks.map((d) => ({ kind: d.kind, member_id: d.memberId, title: d.title, detail: d.detail, severity: d.severity })),
        itinerary_conflicts: r.itineraryConflicts,
        budget: { planned_cents: r.budget.plannedCents, spent_cents: r.budget.spentCents, over: r.budget.over },
      });
    },
  }),

  defineTool({
    name: 'trips.documentsRisk',
    aliases: ['trip_document_risks', 'check_passports'],
    description: 'Missing or expiring travel documents for a trip: passports per traveler on international trips, anything expiring before the return.',
    domain: 'travel',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ vacation_id: z.string() }),
    output: z.object({ risks: z.array(documentRisk) }),
    summarize: (_input, output) => (output.risks.length === 0 ? 'Travel documents look fine' : `${plural(output.risks.length, 'document risk')}: ${output.risks[0].title}`),
    execute: async (scope, input) => {
      const res = await documentsRisk(scope, input.vacation_id);
      if (!res.ok) return res;
      return ok({ risks: res.data.map((d) => ({ kind: d.kind, member_id: d.memberId, title: d.title, detail: d.detail, severity: d.severity })) });
    },
  }),

  defineTool({
    name: 'trips.syncToCalendar',
    aliases: ['sync_trip_to_calendar', 'add_trip_to_calendar'],
    description: 'Put the trip on the family calendar: the trip itself as an all-day span, plus each flight and timed reservation. Skips anything already there.',
    domain: 'travel',
    capability: 'create',
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({ vacation_id: z.string() }),
    output: z.object({
      created: z.array(z.object({ id: z.string(), title: z.string(), starts_at: z.string(), when: z.string() })),
      skipped: z.array(z.string()),
    }),
    idempotencyFrom: (input) => `trips.syncToCalendar:${input.vacation_id}`,
    summarize: (_input, output) => (output.created.length === 0
      ? 'The trip was already on the calendar'
      : `Added ${plural(output.created.length, 'calendar entry', 'calendar entries')} for the trip, starting ${output.created[0].when}`),
    consequences: (input) => [`Adds the trip ${input.vacation_id ?? ''}, its flights and timed reservations to the shared family calendar.`],
    execute: async (scope, input) => {
      const res = await syncToCalendar(scope, input.vacation_id);
      if (!res.ok) return res;
      const now = scopeNow(scope);
      return ok({
        created: res.data.created.map((e) => ({ id: e.id, title: e.title, starts_at: e.startsAt, when: describeDay(e.startsAt, scope.tz, now) })),
        skipped: res.data.skipped,
      });
    },
  }),

  defineTool({
    name: 'trips.commitmentConflicts',
    aliases: ['trip_conflicts', 'what_clashes_with_trip'],
    description: 'Everything already committed during the trip dates — calendar events, school, practices, homework due, bills due — that has to be moved, skipped or paid early.',
    domain: 'travel',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ vacation_id: z.string() }),
    output: z.object({
      window: z.object({ from: z.string(), to: z.string() }),
      total: z.number().int(),
      items: z.array(z.object({
        source: z.enum(['calendar', 'school', 'sports', 'homework', 'bill']),
        id: z.string(), title: z.string(), when: z.string(), starts_at: z.string().nullable(), member_id: z.string().nullable(),
      })),
    }),
    summarize: (_input, output) => (output.total === 0
      ? 'Nothing clashes with the trip'
      : `${plural(output.total, 'commitment')} during the trip, starting with ${output.items[0].title} ${output.items[0].when}`),
    execute: async (scope, input) => {
      const res = await commitmentConflicts(scope, input.vacation_id);
      if (!res.ok) return res;
      const now = scopeNow(scope);
      const c = res.data;
      const items = [
        ...c.calendar.map((e) => ({ source: 'calendar' as const, id: e.id, title: e.title, starts_at: e.starts_at, when: describeWhen(e.starts_at, scope.tz, now), member_id: e.assignee_id })),
        ...c.school.map((e) => ({ source: 'school' as const, id: e.id, title: e.title, starts_at: e.starts_at, when: describeWhen(e.starts_at, scope.tz, now), member_id: e.member_id })),
        ...c.sports.map((e) => ({ source: 'sports' as const, id: e.id, title: e.title, starts_at: e.starts_at, when: describeWhen(e.starts_at, scope.tz, now), member_id: e.member_id })),
        ...c.homework.map((h) => ({ source: 'homework' as const, id: h.id, title: `${h.title} (homework)`, starts_at: h.due_at, when: describeWhen(h.due_at, scope.tz, now), member_id: h.member_id })),
        ...c.bills.map((b) => ({ source: 'bill' as const, id: b.id, title: `${b.name} (bill due)`, starts_at: `${b.due_date}T00:00:00Z`, when: b.due_date, member_id: null })),
      ].sort((a, b) => Date.parse(a.starts_at ?? '') - Date.parse(b.starts_at ?? ''));
      return ok({ window: c.window, total: c.total, items });
    },
  }),

  defineTool({
    name: 'trips.petPrep',
    aliases: ['trip_pet_prep', 'pet_care_for_trip'],
    description: 'The care each family pet needs while everyone is away: one sitter or boarding task per animal, with its name, care notes and vet.',
    domain: 'travel',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ vacation_id: z.string() }),
    output: z.object({
      trip_id: z.string(),
      trip_title: z.string(),
      tasks: z.array(z.object({
        pet_id: z.string(), pet_name: z.string(), species: z.string(), title: z.string(), notes: z.string(), due_date: z.string().nullable(),
      })),
    }),
    summarize: (_input, output) => (output.tasks.length === 0
      ? 'No pets are on file, so nothing needs a sitter'
      : `${plural(output.tasks.length, 'pet')} need care during ${output.trip_title}: ${output.tasks.map((t) => t.pet_name).join(', ')}`),
    execute: async (scope, input) => {
      const res = await petPrep(scope, input.vacation_id);
      if (!res.ok) return res;
      return ok({
        trip_id: res.data.tripId,
        trip_title: res.data.tripTitle,
        tasks: res.data.tasks.map((t) => ({
          pet_id: t.petId, pet_name: t.petName, species: t.species, title: t.title, notes: t.notes, due_date: t.dueDate,
        })),
      });
    },
  }),

  defineTool({
    name: 'trips.createPetCareTasks',
    aliases: ['create_pet_care_tasks', 'arrange_pet_care'],
    description: 'Add one sitter or boarding task per family pet for a trip, each carrying the care notes for that animal. Adds nothing when the tasks already exist.',
    domain: 'travel',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      vacation_id: z.string(),
      assignee: z.string().nullish().describe('Who arranges the care'),
      assignee_id: z.string().nullish(),
    }),
    output: z.object({
      pets: z.number().int(),
      created: z.array(z.object({ pet_id: z.string(), pet_name: z.string(), todo_id: z.string(), title: z.string() })),
    }),
    idempotencyFrom: (input) => `trips.createPetCareTasks:${input.vacation_id}`,
    summarize: (_input, output) => (output.created.length === 0
      ? 'No pets are on file, so no care tasks were needed'
      : `Added a care task for ${output.created.map((c) => c.pet_name).join(', ')}`),
    consequences: (input) => [`Adds one to-do per family pet for trip ${input.vacation_id ?? ''}. Nothing is booked with a sitter or a kennel.`],
    execute: async (scope, input) => {
      const assignee = await resolveAssigneeId(scope, { assignee: input.assignee, assignee_id: input.assignee_id });
      if (!assignee.ok) return assignee;
      const res = await createPetCareTasks(scope, input.vacation_id, assignee.data ? { assigneeId: assignee.data } : {});
      if (!res.ok) return res;
      return ok({
        pets: res.data.pets,
        created: res.data.created.map((c) => ({ pet_id: c.petId, pet_name: c.petName, todo_id: c.todoId, title: c.title })),
      });
    },
  }),

  defineTool({
    name: 'trips.replanDisruption',
    aliases: ['replan_trip_disruption', 'flight_delayed'],
    description: 'Work out how a delayed or cancelled flight or hotel re-flows the itinerary: what moves, and what a person still has to rebook. Plans only — it changes nothing and rebooks nothing.',
    domain: 'travel',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      vacation_id: z.string(),
      kind: z.enum(['flight', 'lodging']),
      booking_id: z.string().describe('The flight or lodging row this is about'),
      delay_minutes: z.number().int().nullish(),
      cancelled: z.boolean().nullish(),
    }),
    output: z.object({
      trip_id: z.string(),
      booking: z.object({ kind: z.string(), id: z.string(), label: z.string(), day: z.string() }),
      no_change: z.boolean(),
      summary: z.string(),
      shifted_items: z.array(z.object({
        id: z.string(), title: z.string(), from_start: z.string().nullable(), to_day: z.string(), to_start: z.string().nullable(), rolled_overnight: z.boolean(),
      })),
      to_rebook: z.array(z.object({ kind: z.string(), id: z.string(), title: z.string(), reason: z.string(), when: z.string().nullable() })),
      new_conflicts: z.array(z.object({ kind: z.string(), title: z.string(), detail: z.string() })),
    }),
    // The vocabulary here is load-bearing: nothing was rebooked, and the
    // summary must never imply otherwise.
    summarize: (_input, output) => output.summary,
    execute: async (scope, input) => {
      const res = await planTripDisruption(scope, input.vacation_id, {
        kind: input.kind,
        bookingId: input.booking_id,
        delayMinutes: input.delay_minutes ?? 0,
        cancelled: input.cancelled ?? false,
      });
      if (!res.ok) return res;
      const { plan, booking } = res.data;
      return ok({
        trip_id: res.data.tripId,
        booking: { kind: booking.kind, id: booking.id, label: booking.label, day: booking.day },
        no_change: plan.noop,
        summary: plan.summary,
        shifted_items: plan.shiftedItems.map((s) => ({
          id: s.id, title: s.title, from_start: s.fromStart, to_day: s.toDay, to_start: s.toStart, rolled_overnight: s.rolledOvernight,
        })),
        to_rebook: plan.toRebook.map((r) => ({ kind: r.kind, id: r.id, title: r.title, reason: r.reason, when: r.when })),
        new_conflicts: plan.conflicts.map((c) => ({ kind: c.kind, title: c.title, detail: c.detail })),
      });
    },
  }),
];
