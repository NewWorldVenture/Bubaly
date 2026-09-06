// Workflow E — Prepare our vacation (§18, §8's twenty-step example). Owner:
// the Travel Planner.
//
// Every step keys off a `vacation_id`. A step CAN now read an earlier step's
// output (`$fromStep`, lib/ai/runs/bindings.ts) — the verify step below uses it
// to name the rows this run wrote — but a trip already on file is still what
// lets the whole skeleton be written at once. The context's travel slice carries the upcoming
// trips; when it holds one that matches, the template writes its id into
// every step. When it holds none, the skeleton's first step puts the trip on
// file and the guidance tells the model to stop there and follow up, rather
// than invent an id.
import { localTime, shiftDay, type TemplateContext, type WorkflowTemplate } from './index';

/** The trip the request is about: the soonest upcoming one, unless the entities name another. */
function tripFor(ctx: TemplateContext): TemplateContext['trips'][number] | null {
  if (!ctx.trips.length) return null;
  const wanted = (ctx.entities.trip ?? ctx.entities.destination ?? ctx.entities.topic ?? '').trim().toLowerCase();
  if (wanted) {
    const named = ctx.trips.find((t) => t.title.toLowerCase().includes(wanted));
    if (named) return named;
  }
  return [...ctx.trips].sort((a, b) => (a.daysUntil ?? 9999) - (b.daysUntil ?? 9999))[0] ?? null;
}

function vacationId(ctx: TemplateContext): string {
  return tripFor(ctx)?.id ?? '';
}

function departureKey(ctx: TemplateContext): string {
  return tripFor(ctx)?.startDate ?? shiftDay(ctx.todayKey, 14);
}

export const prepareVacationTemplate: WorkflowTemplate = {
  intent: 'prepare_vacation',
  agent: 'travel_planner',
  title: 'Prepare for the trip',
  deterministic: false,
  objective: (ctx) => {
    const trip = tripFor(ctx);
    return trip ? `Get the family ready for ${trip.title}: documents, packing, tasks, calendar and home prep.` : 'Put the trip on file and get the family ready for it.';
  },
  guidance: [
    'Use the `vacation_id` of the trip in the context for every trip step. If the context shows no matching trip, keep only the put_trip_on_file step (filled from the request), drop every step that needs a vacation_id, and add a followup for one hour later with the prompt "Prepare the trip that is now on file".',
    'Each traveller with a conflict, a missing document or a packing list gets their own task with them (or a parent for a child) as assignee; repeat prep_task as prep_task_2 and so on.',
    'Add a reminder two days before departure for the critical items and one the evening before for the home checklist (trash, mail, pets, thermostat).',
    'Never invent a trip, a date or a document the context does not show.',
  ],
  steps: [
    {
      key: 'put_trip_on_file', stepType: 'act', toolName: 'trips.findOrCreateVacation', description: 'Put the trip on file',
      input: (ctx) => ({ title: ctx.entities.trip ?? ctx.entities.destination ?? null, destination: ctx.entities.destination ?? null, start_date: ctx.entities.start_date ?? null, end_date: ctx.entities.end_date ?? null }),
      modelFills: 'title, destination and dates from the request — only when no trip is on file', optional: true,
    },
    { key: 'trip', stepType: 'retrieve', toolName: 'trips.getTrip', description: 'Read the trip details and travellers', input: (ctx) => ({ vacation_id: vacationId(ctx) }) },
    { key: 'conflicts', stepType: 'retrieve', toolName: 'trips.commitmentConflicts', description: 'Find commitments that overlap the trip', input: (ctx) => ({ vacation_id: vacationId(ctx) }) },
    { key: 'documents', stepType: 'retrieve', toolName: 'trips.documentsRisk', description: 'Check passports and travel documents', input: (ctx) => ({ vacation_id: vacationId(ctx) }) },
    { key: 'readiness_before', stepType: 'retrieve', toolName: 'trips.computeReadiness', description: 'Measure how ready the family is today', input: (ctx) => ({ vacation_id: vacationId(ctx) }) },
    { key: 'home_tasks', stepType: 'retrieve', toolName: 'home.listOpenMaintenance', description: 'Check home tasks due before departure', input: (ctx) => ({ due_before: localTime(departureKey(ctx), 23, 59) }), optional: true },
    {
      key: 'build_plan', stepType: 'act', toolName: 'trips.buildPlan', description: 'Build the trip plan: activities, budget and checklists',
      dependsOn: ['trip', 'conflicts', 'documents'], input: (ctx) => ({ vacation_id: vacationId(ctx), preferences: null }),
      modelFills: 'preferences: what the family wants from the trip, from the request and the context', optional: true,
    },
    { key: 'packing_lists', stepType: 'act', toolName: 'trips.createPackingList', description: 'Create a packing list for each traveller', dependsOn: ['trip'], input: (ctx) => ({ vacation_id: vacationId(ctx), per_traveler: true }) },
    { key: 'calendar', stepType: 'act', toolName: 'trips.syncToCalendar', description: 'Put departure and return on the calendar', dependsOn: ['trip', 'conflicts'], input: (ctx) => ({ vacation_id: vacationId(ctx) }) },
    {
      key: 'prep_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Add the preparation task that matters most',
      dependsOn: ['documents', 'conflicts', 'readiness_before'], input: (ctx) => ({ title: '', due_date: shiftDay(departureKey(ctx), -3), priority: 'high' }),
      modelFills: 'title and assignee — one copy per traveller or issue', optional: true,
    },
    {
      key: 'home_checklist', stepType: 'act', toolName: 'tasks.createTodo', description: 'Add the home-away checklist',
      dependsOn: ['home_tasks'], input: (ctx) => ({ title: 'Before we leave: trash out, mail held, pets covered, thermostat set', due_date: shiftDay(departureKey(ctx), -1), priority: 'medium' }),
    },
    {
      key: 'critical_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Remind the family about the critical items two days before',
      dependsOn: ['prep_task', 'packing_lists'], input: (ctx) => ({ title: 'Trip in two days: passports, tickets and packing', remind_at: localTime(shiftDay(departureKey(ctx), -2), 18), kind: 'time', priority: 'high' }),
    },
    {
      key: 'check_readiness', stepType: 'retrieve', toolName: 'trips.computeReadiness', description: 'Re-check readiness after the prep is in place',
      dependsOn: ['build_plan', 'packing_lists', 'calendar', 'prep_task', 'home_checklist'], input: (ctx) => ({ vacation_id: vacationId(ctx) }),
    },
    {
      // The spec's own example of verification (§13): the trip is only
      // "prepared" if the dates are on the calendar and the reminder exists.
      key: 'check_trip', stepType: 'verify', description: 'Check the trip is really on the calendar and reminded',
      dependsOn: ['calendar', 'critical_reminder'],
      // Named, not counted. `count_at_least` on a family-wide table is
      // satisfied by rows the family already had — this run could have written
      // nothing and still passed. `$fromStep` binds the ids these two steps
      // actually produced (lib/ai/runs/bindings.ts), which is the check §13
      // asks for and the one `records_exist` was built for.
      input: (ctx) => ({
        checks: [
          { kind: 'records_exist', table: 'calendar_events', ids: [{ $fromStep: 'calendar', path: 'id' }], label: 'Travel dates are on the calendar' },
          { kind: 'records_exist', table: 'family_reminders', ids: [{ $fromStep: 'critical_reminder', path: 'id' }], label: 'The pre-trip reminder is set' },
          { kind: 'no_calendar_conflicts', start: localTime(departureKey(ctx), 0), end: localTime(departureKey(ctx), 23, 59), label: 'Departure day is clear' },
        ],
      }),
    },
    {
      key: 'tell_family', stepType: 'notify', description: 'Tell the family what is ready and what is still open',
      dependsOn: ['check_trip', 'check_readiness', 'critical_reminder'],
      input: () => ({ recipients: 'family', type: 'system', title: 'Trip prep is under way', body: '' }),
      modelFills: 'body: what is on the calendar, whose packing lists exist, and the open items with owners',
    },
  ],
  followups: (ctx) => {
    const trip = tripFor(ctx);
    if (!trip?.startDate) return [];
    return [{ after: localTime(shiftDay(trip.startDate, -2), 9), prompt: `Two days before ${trip.title}: check the packing lists and tasks, and escalate anything critical that is still open.` }];
  },
};
