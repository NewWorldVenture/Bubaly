// Workflow — Back to school (M25). Owner: the School Coordinator.
//
// The difference between this and the `school_start` life-event checklist is
// the difference between a list and a run: the checklist tells a family what to
// do, this puts the supplies on the shopping list, the forms on someone's
// to-do, the first day on the calendar and the deadline reminders in the
// future. Both exist on purpose — a household that has turned Bubaly's actions
// off still gets the checklist.
import { localTime, shiftDay, type TemplateContext, type WorkflowTemplate } from './index';

/** The first day back: the named date, else four weeks out — long enough for the ordering deadlines to still be ahead. */
export function firstDayKey(ctx: TemplateContext): string {
  const named = (ctx.entities.day ?? ctx.entities.date ?? ctx.entities.start_date ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(named) ? named : shiftDay(ctx.todayKey, 28);
}

export const backToSchoolTemplate: WorkflowTemplate = {
  intent: 'back_to_school',
  agent: 'school_coordinator',
  title: 'Get ready for the school year',
  deterministic: false,
  objective: (ctx) => `Be ready for the first day on ${firstDayKey(ctx)}: supplies bought, forms in, care arranged and the routine already shifting.`,
  guidance: [
    'Work back from the first day. Supplies and forms are three weeks out; the routine shift is one week out; the first-day block is the day itself.',
    'Put the supply list on the shopping list as ONE groceries.addItems step with every item, not one step per pencil.',
    'One forms task per child (forms_task, forms_task_2 …) naming that child\'s school and what it is asking for.',
    'Use the documents step to check immunisation records and IDs that expire before the first day; only add a renewal task for one the context actually shows as expiring.',
    'Drop the after-school care step when the context shows care is already arranged.',
  ],
  steps: [
    { key: 'members', stepType: 'retrieve', toolName: 'family.listMembers', description: 'Confirm which children are going back', input: () => ({}) },
    { key: 'classes', stepType: 'retrieve', toolName: 'school.listClasses', description: 'Read the timetable on file', input: () => ({}) },
    { key: 'school_events', stepType: 'retrieve', toolName: 'school.listEventsBetween', description: 'Read orientation and term dates already on file', input: (ctx) => ({ from: localTime(ctx.todayKey, 0), to: localTime(shiftDay(firstDayKey(ctx), 14), 23, 59) }) },
    { key: 'documents', stepType: 'retrieve', toolName: 'documents.expiringBefore', description: 'Check records and IDs that expire before the first day', input: (ctx) => ({ date: firstDayKey(ctx) }) },
    { key: 'open_tasks', stepType: 'retrieve', toolName: 'tasks.searchTodos', description: 'Read what is already on the list for the school year', input: (ctx) => ({ done: false, due_before: firstDayKey(ctx), limit: 30 }) },
    { key: 'grocery', stepType: 'retrieve', toolName: 'groceries.listOpen', description: 'Read what is already on the shopping list', input: () => ({ limit: 50 }) },
    { key: 'preferences', stepType: 'retrieve', toolName: 'memory.recall', description: 'Recall sizes and preferences for the school shop', input: () => ({ category: 'sizes', limit: 20 }) },
    {
      key: 'supplies', stepType: 'act', toolName: 'groceries.addItems', description: 'Put the school supplies on the shopping list',
      dependsOn: ['classes', 'grocery', 'preferences'],
      input: () => ({ items: [] }),
      modelFills: 'items: the supply list for these children and these classes, with quantities',
    },
    {
      key: 'forms_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Get one child\'s forms and enrolment done',
      dependsOn: ['members', 'documents', 'open_tasks'],
      input: (ctx) => ({ title: '', due_date: shiftDay(firstDayKey(ctx), -21), priority: 'high' }),
      modelFills: 'title naming the child, the school and the forms, with a parent as assignee',
    },
    {
      key: 'care_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Arrange after-school care',
      dependsOn: ['members', 'classes'],
      input: (ctx) => ({ title: 'Arrange after-school care for the new term', due_date: shiftDay(firstDayKey(ctx), -14), priority: 'medium' }),
      optional: true,
    },
    {
      key: 'first_day', stepType: 'act', toolName: 'calendar.createEvent', description: 'Put the first day on the calendar',
      dependsOn: ['school_events'],
      input: (ctx) => ({ title: 'First day of school', starts_at: localTime(firstDayKey(ctx), 8), ends_at: localTime(firstDayKey(ctx), 15), category: 'school' }),
    },
    {
      key: 'routine_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Start shifting bedtimes a week out',
      dependsOn: ['first_day'],
      input: (ctx) => ({ title: 'Start moving bedtimes back for the school year', remind_at: localTime(shiftDay(firstDayKey(ctx), -7), 18), kind: 'time', priority: 'medium' }),
    },
    {
      key: 'check_ready', stepType: 'verify', description: 'Check the supplies, the forms and the first day really landed',
      dependsOn: ['supplies', 'forms_task', 'first_day'],
      input: () => ({
        checks: [
          { kind: 'records_exist', table: 'todo_items', ids: [{ $fromStep: 'forms_task', path: 'id' }], label: 'The forms are on someone\'s list' },
          { kind: 'records_exist', table: 'calendar_events', ids: [{ $fromStep: 'first_day', path: 'id' }], label: 'The first day is on the calendar' },
        ],
      }),
    },
    {
      key: 'tell_family', stepType: 'notify', description: 'Tell the family what is handled and what is left',
      dependsOn: ['check_ready', 'care_task', 'routine_reminder'],
      input: () => ({ recipients: 'family', type: 'system', title: 'The school year is being set up', body: '' }),
      modelFills: 'body: what is on the shopping list, whose forms are due when, and what still needs a decision',
    },
  ],
  followups: (ctx) => [{ after: localTime(shiftDay(firstDayKey(ctx), -7), 9), prompt: 'A week before the first day of school: check the supplies were bought and the forms went in, and chase whatever is still open.' }],
};
