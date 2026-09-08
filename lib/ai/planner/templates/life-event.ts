// Workflow — A life event (M34). Owner: the Chief of Staff.
//
// "We're getting a puppy" is not a task and not a question. It is a transition:
// a date the household is heading towards, a handful of things that must exist
// before it, and a routine that changes afterwards. The life-event CHECKLIST
// (lib/life-events/templates.ts) is the same knowledge in the form a family
// without Bubaly's actions can still use; this template is the form that
// actually books the vet, buys the crate and blocks the day.
//
// The template deliberately does NOT name a transition. Ten different ones
// share this shape, and hard-coding "puppy" would make nine of them wrong; the
// model names it from the request and the household context.
import { localTime, shiftDay, type TemplateContext, type WorkflowTemplate } from './index';

/** The date the transition happens: the named date, else three weeks out. */
export function transitionKey(ctx: TemplateContext): string {
  const named = (ctx.entities.day ?? ctx.entities.date ?? ctx.entities.start_date ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(named) ? named : shiftDay(ctx.todayKey, 21);
}

/** What the family called it, when the classifier read a topic out of the request. */
export function transitionName(ctx: TemplateContext): string {
  return (ctx.entities.topic ?? ctx.entities.event ?? '').trim();
}

export const lifeEventTemplate: WorkflowTemplate = {
  intent: 'life_event',
  agent: 'chief_of_staff',
  title: 'Plan the life event',
  deterministic: false,
  objective: (ctx) => {
    const name = transitionName(ctx);
    return name
      ? `Get the household ready for ${name} on ${transitionKey(ctx)}: what has to exist before the day, and what changes after it.`
      : `Get the household ready for the change coming on ${transitionKey(ctx)}: what has to exist before the day, and what changes after it.`;
  },
  guidance: [
    'Name the transition from the request in the objective and in every step — a new pet, a new baby, a new job, a renovation, a parent moving closer.',
    'Plan only what has to happen BEFORE the date plus the first week after it. Anything further out belongs in a follow-up, not in this run.',
    'One task per thing that must exist by the day (prep_task, prep_task_2, prep_task_3 …), each with an owner and a due date working back from the date.',
    'Put the supplies on the shopping list in one groceries.addItems step; drop that step for a transition that needs nothing bought.',
    'Set approval_required on any step that commits money or books a professional.',
    'Never state the transition as a fact the household did not tell you — if the request is vague about what is changing, ask one clarifying question instead of planning.',
  ],
  steps: [
    { key: 'members', stepType: 'retrieve', toolName: 'family.listMembers', description: 'Confirm who this change affects', input: () => ({}) },
    { key: 'events', stepType: 'retrieve', toolName: 'calendar.searchEvents', description: 'Read what is already booked in the run-up', input: (ctx) => ({ from: localTime(ctx.todayKey, 0), to: localTime(shiftDay(transitionKey(ctx), 7), 23, 59), limit: 50 }) },
    { key: 'open_tasks', stepType: 'retrieve', toolName: 'tasks.searchTodos', description: 'Read what the family already has open for it', input: (ctx) => ({ done: false, due_before: shiftDay(transitionKey(ctx), 7), limit: 30 }) },
    { key: 'grocery', stepType: 'retrieve', toolName: 'groceries.listOpen', description: 'Read what is already on the shopping list', input: () => ({ limit: 50 }) },
    { key: 'known', stepType: 'retrieve', toolName: 'memory.recall', description: 'Recall what Bubaly already knows about this household', input: (ctx) => ({ category: 'about', query: transitionName(ctx) || null, limit: 20 }) },
    {
      key: 'block_day', stepType: 'act', toolName: 'calendar.createEvent', description: 'Put the day itself on the calendar',
      dependsOn: ['events'],
      input: (ctx) => ({ title: '', starts_at: localTime(transitionKey(ctx), 9), ends_at: localTime(transitionKey(ctx), 12), category: 'general' }),
      modelFills: 'title naming the transition, and starts_at/ends_at from the date in the request',
    },
    {
      key: 'prep_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Sort the thing that has to exist first',
      dependsOn: ['members', 'open_tasks', 'known'],
      input: (ctx) => ({ title: '', due_date: shiftDay(transitionKey(ctx), -7), priority: 'high' }),
      modelFills: 'title naming the specific preparation, with an owner as assignee',
    },
    {
      key: 'supplies', stepType: 'act', toolName: 'groceries.addItems', description: 'Put what has to be bought on the shopping list',
      dependsOn: ['grocery'],
      input: () => ({ items: [] }),
      modelFills: 'items: only what this transition actually needs bought', optional: true,
    },
    {
      key: 'day_before_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Remind the family the day before',
      dependsOn: ['block_day', 'prep_task'],
      input: (ctx) => ({ title: '', remind_at: localTime(shiftDay(transitionKey(ctx), -1), 18), kind: 'time', priority: 'high' }),
      modelFills: 'title naming what has to be ready by the morning',
    },
    {
      key: 'settle_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Book the first week after the change',
      dependsOn: ['block_day'],
      input: (ctx) => ({ title: '', due_date: shiftDay(transitionKey(ctx), 5), priority: 'medium' }),
      modelFills: 'title naming the first follow-up the transition needs — a first check-up, a first payroll form, a first review', optional: true,
    },
    {
      key: 'check_plan', stepType: 'verify', description: 'Check the day and the first task really exist',
      dependsOn: ['block_day', 'prep_task', 'day_before_reminder'],
      input: () => ({
        checks: [
          { kind: 'records_exist', table: 'calendar_events', ids: [{ $fromStep: 'block_day', path: 'id' }], label: 'The day is on the calendar' },
          { kind: 'records_exist', table: 'todo_items', ids: [{ $fromStep: 'prep_task', path: 'id' }], label: 'The first preparation is on someone\'s list' },
          { kind: 'records_exist', table: 'family_reminders', ids: [{ $fromStep: 'day_before_reminder', path: 'id' }], label: 'The day-before reminder is set' },
        ],
      }),
    },
    {
      key: 'tell_family', stepType: 'notify', description: 'Tell the family what is now in place',
      dependsOn: ['check_plan', 'supplies', 'settle_task'],
      input: () => ({ recipients: 'family', type: 'system', title: 'The plan for what is coming', body: '' }),
      modelFills: 'body: the date, who owns what, what is on the shopping list, and what is still open',
    },
  ],
  followups: (ctx) => [{ after: localTime(shiftDay(transitionKey(ctx), 7), 9), prompt: 'A week after the change: check what actually happened, close what is done and re-plan what slipped.' }],
};
