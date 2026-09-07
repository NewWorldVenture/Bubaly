// Workflow — The holidays (M25). Owner: the Chief of Staff, because the
// holiday season is the one time of year when every other specialist's work
// collides: the calendar fills with other people's plans, the food is a
// project, the money is a project, and half the family is travelling.
//
// The template plans the run-up to ONE holiday date, not the whole season: a
// plan that tries to cover December from the first of November is a plan
// nobody reads.
import { localTime, shiftDay, type TemplateContext, type WorkflowTemplate } from './index';

/** The holiday being planned: the named date, else three weeks out. */
export function holidayKey(ctx: TemplateContext): string {
  const named = (ctx.entities.day ?? ctx.entities.date ?? ctx.entities.start_date ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(named) ? named : shiftDay(ctx.todayKey, 21);
}

export const holidayTemplate: WorkflowTemplate = {
  intent: 'holiday',
  agent: 'chief_of_staff',
  title: 'Plan the holiday',
  deterministic: false,
  objective: (ctx) => `Get the family to ${holidayKey(ctx)} without the scramble: the day itself on the calendar, the food and the gifts on lists, and the deadlines reminded.`,
  guidance: [
    'Name the holiday from the request; if the request does not name one, ask rather than guessing which one the family means.',
    'Put ONE calendar block on the holiday itself. Travel days, if the context shows a trip, get their own block keyed travel_block.',
    'The shopping list gets the food in one groceries.addItems step. Gifts are a task per person being bought for, keyed gift_task, gift_task_2 …, never a single "buy gifts".',
    'Set approval_required on anything that commits money the family has not already agreed to.',
    'Use the budget in the context if there is one; never invent an amount.',
  ],
  steps: [
    { key: 'members', stepType: 'retrieve', toolName: 'family.listMembers', description: 'Confirm who is here for the holiday', input: () => ({}) },
    { key: 'events', stepType: 'retrieve', toolName: 'calendar.searchEvents', description: 'Read what is already booked around the holiday', input: (ctx) => ({ from: localTime(shiftDay(holidayKey(ctx), -14), 0), to: localTime(shiftDay(holidayKey(ctx), 3), 23, 59), limit: 50 }) },
    { key: 'conflicts', stepType: 'retrieve', toolName: 'calendar.findConflicts', description: 'Look for clashes in the run-up', input: (ctx) => ({ from: localTime(shiftDay(holidayKey(ctx), -7), 0), to: localTime(shiftDay(holidayKey(ctx), 1), 23, 59) }) },
    { key: 'grocery', stepType: 'retrieve', toolName: 'groceries.listOpen', description: 'Read what is already on the shopping list', input: () => ({ limit: 50 }) },
    { key: 'traditions', stepType: 'retrieve', toolName: 'memory.recall', description: 'Recall the family traditions and who eats what', input: () => ({ category: 'preference', query: 'holiday', limit: 20 }) },
    { key: 'open_tasks', stepType: 'retrieve', toolName: 'tasks.searchTodos', description: 'Read what is already on the list for the holiday', input: (ctx) => ({ done: false, due_before: holidayKey(ctx), limit: 30 }) },
    {
      key: 'block_day', stepType: 'act', toolName: 'calendar.createEvent', description: 'Put the holiday on the calendar',
      dependsOn: ['events', 'conflicts'],
      input: (ctx) => ({ title: '', starts_at: localTime(holidayKey(ctx), 9), ends_at: localTime(holidayKey(ctx), 21), category: 'holiday' }),
      modelFills: 'title naming the holiday and where it is being held',
    },
    {
      key: 'food_list', stepType: 'act', toolName: 'groceries.addItems', description: 'Put the holiday food on the shopping list',
      dependsOn: ['grocery', 'traditions', 'members'],
      input: () => ({ items: [] }),
      modelFills: 'items: the holiday shop for this many people, respecting the diets in the context',
    },
    {
      key: 'gift_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Sort one person\'s gift',
      dependsOn: ['members', 'traditions', 'open_tasks'],
      input: (ctx) => ({ title: '', due_date: shiftDay(holidayKey(ctx), -10), priority: 'medium' }),
      modelFills: 'title naming who the gift is for, and the buyer as assignee', optional: true,
    },
    {
      key: 'cook_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Remind whoever is cooking, in time to shop',
      dependsOn: ['food_list', 'block_day'],
      input: (ctx) => ({ title: 'Holiday shop and prep — the big cook is in three days', remind_at: localTime(shiftDay(holidayKey(ctx), -3), 17), kind: 'time', priority: 'high' }),
    },
    {
      key: 'check_holiday', stepType: 'verify', description: 'Check the day and the reminder really exist',
      dependsOn: ['block_day', 'cook_reminder'],
      input: () => ({
        checks: [
          { kind: 'records_exist', table: 'calendar_events', ids: [{ $fromStep: 'block_day', path: 'id' }], label: 'The holiday is on the calendar' },
          { kind: 'records_exist', table: 'family_reminders', ids: [{ $fromStep: 'cook_reminder', path: 'id' }], label: 'The cook has a reminder' },
        ],
      }),
    },
    {
      key: 'tell_family', stepType: 'notify', description: 'Share the holiday plan',
      dependsOn: ['check_holiday', 'gift_task', 'food_list'],
      input: () => ({ recipients: 'family', type: 'system', title: 'The holiday plan is taking shape', body: '' }),
      modelFills: 'body: the day, the meal, who is buying what, and what still needs a decision',
    },
  ],
  followups: (ctx) => [{ after: localTime(shiftDay(holidayKey(ctx), -7), 9), prompt: 'A week out from the holiday: check the shopping and the gifts, and chase anything still open.' }],
};
