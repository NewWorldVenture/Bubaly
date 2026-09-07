// The chief-of-staff skeleton: the generic shape for a request that reaches
// across the household and matches no single workflow (§18's "broad ask").
// Owner: the Chief of Staff, the roster agent that keeps the whole household
// on track rather than one area of it.
//
// WHY a template for the un-templated: without one, a broad request fell to
// `other` and the model planned from a blank page — the failure mode templates
// exist to prevent (tools that do not exist, writes before reads, a notification
// to nobody). This skeleton fixes the SHAPE and leaves the content to the model:
//
//   1. reads first, everywhere the request could reach, all independent so
//      the executor runs them together (MAX_STEP_CONCURRENCY at a time);
//   2. then act steps grouped by area, each depending only on the reads of its
//      own area, so independent work still runs in parallel and each step can
//      be approved, retried and reported on its own;
//   3. then one notification to the person who asked, behind everything.
//
// Every act step is `optional` with a `modelFills` hint: the model keeps the
// areas the request touches, copies a step per created thing, and drops the
// rest. `approval_required` is left to the validator's trust dry run
// (lib/ai/planner/validate.ts), so a step is gated exactly where household
// policy or the risk tier says so and nowhere else — "safe work first" is a
// property of the graph, not a promise in the prompt.
//
// Not deterministic: with nothing to fill, the skeleton is a readiness sweep
// with no actions, and a routine that wants that has `what_am_i_forgetting`.
import { localTime, mondayOf, shiftDay, type WorkflowTemplate } from './index';

/** The reads every act step of an area waits for. */
const READS_BY_AREA = {
  calendar: ['events', 'conflicts', 'practices', 'homework'],
  tasks: ['todos', 'chores'],
  reminders: ['reminders', 'events'],
  meals: ['meals', 'events'],
  groceries: ['groceries', 'meals'],
  home: ['maintenance'],
} as const;

const ALL_READS = ['events', 'conflicts', 'homework', 'practices', 'todos', 'chores', 'reminders', 'meals', 'groceries', 'maintenance', 'budget', 'expiring'] as const;
const ALL_ACTS = ['calendar_act', 'tasks_act', 'reminder_act', 'meal_act', 'grocery_act', 'home_act'] as const;

export const chiefOfStaffTemplate: WorkflowTemplate = {
  intent: 'chief_of_staff',
  agent: 'chief_of_staff',
  title: 'Chief of staff',
  deterministic: false,
  objective: (ctx) => ctx.requestText.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Look across the household and take care of what needs doing.',
  guidance: [
    'Read first, everywhere the request could reach: keep every read whose result could change what you do and drop the ones that cannot. Reads run together, so an extra read costs little; a missing one costs a wrong action.',
    'Then act, one step per created thing, each depending only on the reads it needs, so independent work runs in parallel and each step can be approved on its own. Copy a skeleton act step once per thing (calendar_act, calendar_act_2, …).',
    'Group actions by area — schedule, tasks, reminders, meals, groceries, home — and keep the areas the request does not touch out of the plan. When the request needs an area with no skeleton step (money, documents, a trip), add the step from the catalogue.',
    'Leave approval_required null so household policy decides; set it true only for money, messages outside the family, or anything hard to undo.',
    'When a trip is on file, add trips.computeReadiness and trips.documentsRisk for it. When the right actions depend on what a read returns and a condition cannot express it, end the plan with one replan step that depends on those reads instead of guessing.',
    'Finish by telling the person who asked what was done and what is waiting on them — outcomes, not steps. Rewrite the notification body once you know what the plan does.',
  ],
  steps: [
    // ── Reads: independent, run together ────────────────────────────────
    { key: 'events', stepType: 'retrieve', toolName: 'calendar.searchEvents', description: 'Read the coming week', input: (ctx) => ({ from: ctx.nowIso, to: localTime(shiftDay(ctx.todayKey, 7), 23, 59), limit: 100 }) },
    { key: 'conflicts', stepType: 'retrieve', toolName: 'calendar.findConflicts', description: 'Look for overlaps', input: (ctx) => ({ from: ctx.nowIso, to: localTime(shiftDay(ctx.todayKey, 7), 23, 59) }) },
    { key: 'homework', stepType: 'retrieve', toolName: 'school.listHomeworkDue', description: 'Check homework due', input: (ctx) => ({ from: ctx.nowIso, to: localTime(shiftDay(ctx.todayKey, 7), 23, 59) }), optional: true },
    { key: 'practices', stepType: 'retrieve', toolName: 'sports.listPracticesBetween', description: 'Check practices and games', input: (ctx) => ({ from: ctx.nowIso, to: localTime(shiftDay(ctx.todayKey, 7), 23, 59) }), optional: true },
    { key: 'todos', stepType: 'retrieve', toolName: 'tasks.searchTodos', description: 'Read the open to-dos', input: (ctx) => ({ done: false, due_before: shiftDay(ctx.todayKey, 7), limit: 50 }) },
    { key: 'chores', stepType: 'retrieve', toolName: 'tasks.listOpenChores', description: 'Read the chore board', input: () => ({ limit: 50 }), optional: true },
    { key: 'reminders', stepType: 'retrieve', toolName: 'reminders.listDue', description: 'See what reminders already cover', input: (ctx) => ({ before: localTime(shiftDay(ctx.todayKey, 7), 23, 59), limit: 50 }), optional: true },
    { key: 'meals', stepType: 'retrieve', toolName: 'meals.getMealPlan', description: 'See what dinners are planned', input: (ctx) => ({ week_start: mondayOf(ctx.todayKey) }), optional: true },
    { key: 'groceries', stepType: 'retrieve', toolName: 'groceries.listOpen', description: 'Read the grocery list', input: () => ({ limit: 50 }), optional: true },
    { key: 'maintenance', stepType: 'retrieve', toolName: 'home.listOpenMaintenance', description: 'Check home tasks due', input: (ctx) => ({ due_before: localTime(shiftDay(ctx.todayKey, 14), 23, 59) }), optional: true },
    { key: 'budget', stepType: 'retrieve', toolName: 'finances.budgetVsActual', description: 'Check the month\'s budgets', input: (ctx) => ({ month: ctx.monthKey }), optional: true },
    { key: 'expiring', stepType: 'retrieve', toolName: 'documents.expiringBefore', description: 'Check documents expiring soon', input: () => ({ within_days: 60 }), optional: true },

    // ── Acts: one per area, each behind the reads of its area only ──────
    {
      key: 'calendar_act', stepType: 'act', toolName: 'calendar.createEvent', description: 'Put what the request needs on the calendar',
      dependsOn: [...READS_BY_AREA.calendar], input: (ctx) => ({ title: '', starts_at: localTime(ctx.tomorrowKey, 9), category: 'general' }),
      modelFills: 'title, starts_at, ends_at and who it is for — one copy per event; drop when the calendar needs nothing', optional: true,
    },
    {
      key: 'tasks_act', stepType: 'act', toolName: 'tasks.createTodo', description: 'Add the to-do the request needs',
      dependsOn: [...READS_BY_AREA.tasks], input: (ctx) => ({ title: '', due_date: ctx.tomorrowKey, priority: 'medium' }),
      modelFills: 'title, assignee and due_date — one copy per task; never duplicate a to-do already in the context', optional: true,
    },
    {
      key: 'reminder_act', stepType: 'act', toolName: 'reminders.create', description: 'Set the reminder the request needs',
      dependsOn: [...READS_BY_AREA.reminders], input: (ctx) => ({ title: '', remind_at: localTime(ctx.tomorrowKey, 8) }),
      modelFills: 'title, remind_at and who it is for — one copy per reminder; drop when a reminder already covers it', optional: true,
    },
    {
      key: 'meal_act', stepType: 'act', toolName: 'meals.setSlot', description: 'Fill the dinner the request needs',
      dependsOn: [...READS_BY_AREA.meals], input: (ctx) => ({ date: ctx.tomorrowKey, meal_type: 'dinner', meal_name: '' }),
      modelFills: 'date and meal_name — one copy per dinner; drop when the meals are not part of the request', optional: true,
    },
    {
      key: 'grocery_act', stepType: 'act', toolName: 'groceries.addItems', description: 'Add what the request needs to the grocery list',
      dependsOn: [...READS_BY_AREA.groceries], input: () => ({ items: [] }),
      modelFills: 'items — only what the open list does not already have; drop when nothing is needed', optional: true,
    },
    {
      key: 'home_act', stepType: 'act', toolName: 'home.createMaintenanceTask', description: 'Log the home task the request needs',
      dependsOn: [...READS_BY_AREA.home], input: (ctx) => ({ title: '', due_at: localTime(shiftDay(ctx.todayKey, 7), 17), priority: 'medium' }),
      modelFills: 'title, due_at and who it is for — one copy per home task; drop when the home is not part of the request', optional: true,
    },

    // ── Tell the asker, behind everything ───────────────────────────────
    {
      key: 'tell_asker', stepType: 'notify', description: 'Tell the person who asked what was done and what is waiting on them',
      dependsOn: [...ALL_READS, ...ALL_ACTS],
      input: (ctx) => ({
        recipients: ctx.viewerMemberId ? [ctx.viewerMemberId] : 'managers', type: 'system', title: 'Bubaly took care of your request',
        // The model rewrites this with what it actually did; without a model
        // the notification still points at the run, which is the record.
        body: 'Bubaly looked across the week, the to-dos, the meals, the list and the house, and did what your request needed. Open the run to see each step and anything waiting on you.',
      }),
    },
  ],
};
