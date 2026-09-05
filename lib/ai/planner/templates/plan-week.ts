// Workflow G — Plan our week (§18, §50): the signature workflow. Owner: the
// Chief of Staff, because it spans every specialist.
//
// Ten reads in parallel, then the writes the context justifies: meals when
// the week has gaps, a grocery list from them, prep tasks and reminders for
// what the calendar demands, a reschedule only when a real clash exists, and
// one summary to the family. A mid-week follow-up closes the loop (§70).
import { localTime, shiftDay, type WorkflowTemplate } from './index';

export const planWeekTemplate: WorkflowTemplate = {
  intent: 'plan_week',
  agent: 'chief_of_staff',
  title: 'Plan the week',
  deterministic: false,
  objective: (ctx) => `Plan the week of ${ctx.weekStartKey}: conflicts, meals, prep, priorities, shopping and reminders.`,
  guidance: [
    'Keep every retrieve step independent so they run together.',
    'Plan dinners only for days the meal plan in the context leaves empty; drop the meal steps when the week is already planned.',
    'Add one prep task per commitment that needs something done beforehand (a form, a ride, equipment), with the person it is for as `assignee`; repeat the prep_task step with keys prep_task_2, prep_task_3 and so on.',
    'Move a calendar event only to resolve a genuine overlap shown in the context, and only when the context shows a free slot; otherwise drop the reschedule step and mention the clash in the summary.',
    'The family summary must name the conflicts found, the meals chosen and the tasks assigned, in plain words.',
  ],
  steps: [
    { key: 'members', stepType: 'retrieve', toolName: 'family.listMembers', description: 'Confirm who is in the household this week', input: () => ({}) },
    { key: 'events', stepType: 'retrieve', toolName: 'calendar.searchEvents', description: 'Read the week\'s calendar', input: (ctx) => ({ from: localTime(ctx.weekStartKey, 0), to: localTime(ctx.weekEndKey, 23, 59), limit: 100 }) },
    { key: 'conflicts', stepType: 'retrieve', toolName: 'calendar.findConflicts', description: 'Look for overlapping commitments', input: (ctx) => ({ from: localTime(ctx.weekStartKey, 0), to: localTime(ctx.weekEndKey, 23, 59) }) },
    { key: 'school', stepType: 'retrieve', toolName: 'school.listEventsBetween', description: 'Check school events', input: (ctx) => ({ from: localTime(ctx.weekStartKey, 0), to: localTime(ctx.weekEndKey, 23, 59) }) },
    { key: 'homework', stepType: 'retrieve', toolName: 'school.listHomeworkDue', description: 'Check homework due this week', input: (ctx) => ({ from: localTime(ctx.weekStartKey, 0), to: localTime(ctx.weekEndKey, 23, 59) }) },
    { key: 'practices', stepType: 'retrieve', toolName: 'sports.listPracticesBetween', description: 'Check practices and games', input: (ctx) => ({ from: localTime(ctx.weekStartKey, 0), to: localTime(ctx.weekEndKey, 23, 59) }) },
    { key: 'todos', stepType: 'retrieve', toolName: 'tasks.searchTodos', description: 'Read the open to-dos', input: (ctx) => ({ done: false, due_before: ctx.weekEndKey, limit: 50 }) },
    { key: 'chores', stepType: 'retrieve', toolName: 'tasks.listOpenChores', description: 'Read the chore board', input: () => ({ limit: 50 }) },
    { key: 'meal_plan', stepType: 'retrieve', toolName: 'meals.getMealPlan', description: 'See which dinners are already planned', input: (ctx) => ({ week_start: ctx.weekStartKey }) },
    { key: 'maintenance', stepType: 'retrieve', toolName: 'home.listOpenMaintenance', description: 'Check home tasks due this week', input: (ctx) => ({ due_before: localTime(ctx.weekEndKey, 23, 59) }), optional: true },
    {
      key: 'plan_dinners', stepType: 'act', toolName: 'meals.planWeek', description: 'Fill the empty dinner slots',
      dependsOn: ['meal_plan', 'events', 'practices'], input: () => ({ entries: [] }), optional: true,
      modelFills: 'entries: one {date, meal_type:"dinner", meal_name, ingredients:[{name}]} per empty dinner slot',
      verify: () => ({ checks: [{ kind: 'count_at_least', table: 'meal_plans', min: 1, label: 'The dinners are saved' }] }),
    },
    { key: 'grocery_list', stepType: 'act', toolName: 'groceries.addFromMealPlan', description: 'Add what the dinners need to the shopping list', dependsOn: ['plan_dinners'], input: (ctx) => ({ week_start: ctx.weekStartKey }), optional: true },
    {
      key: 'prep_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Add a prep task for a commitment that needs it',
      dependsOn: ['events', 'school', 'practices', 'todos'], input: (ctx) => ({ title: '', due_date: ctx.weekStartKey, priority: 'medium' }),
      modelFills: 'title, due_date (the day before the commitment) and assignee (the person it is for)', optional: true,
    },
    {
      key: 'reschedule', stepType: 'act', toolName: 'calendar.rescheduleEvent', description: 'Move the event that clashes',
      dependsOn: ['conflicts', 'events'], input: () => ({ event_id: '', starts_at: '' }),
      modelFills: 'event_id of the event to move and the new starts_at, from a free slot in the context', optional: true,
    },
    {
      key: 'key_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Set the reminder the week most needs',
      dependsOn: ['events', 'school', 'practices'], input: (ctx) => ({ title: '', remind_at: localTime(ctx.weekStartKey, 8), kind: 'time' }),
      modelFills: 'title and remind_at for the one thing most likely to be forgotten', optional: true,
    },
    {
      // §13: the writes above were accepted; this asks the database whether the
      // week actually looks the way the plan promised, so a run that half
      // worked reports "6 of 8" instead of claiming success.
      key: 'check_week', stepType: 'verify', description: 'Check the week really is planned',
      dependsOn: ['plan_dinners', 'prep_task', 'reschedule'],
      input: (ctx) => ({
        checks: [
          { kind: 'count_at_least', table: 'meal_plans', min: 3, label: 'Dinners are on the plan' },
          { kind: 'no_calendar_conflicts', start: localTime(ctx.weekStartKey, 0), end: localTime(ctx.weekEndKey, 23, 59), label: 'Nothing overlaps this week' },
        ],
      }),
    },
    {
      key: 'family_summary', stepType: 'notify', description: 'Send the family the week at a glance',
      dependsOn: ['check_week', 'plan_dinners', 'prep_task', 'key_reminder'],
      input: (ctx) => ({ recipients: 'family', type: 'system', title: `Your week of ${ctx.weekStartKey} is planned`, body: '' }),
      modelFills: 'body: the conflicts found, the dinners chosen, the tasks assigned and the reminders set, in two or three sentences',
    },
  ],
  followups: (ctx) => [
    { after: localTime(shiftDay(ctx.weekStartKey, 3), 8), prompt: 'Mid-week check: are the prep tasks done and has anything new landed on the calendar?' },
  ],
};
