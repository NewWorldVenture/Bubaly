// "What am I forgetting?" (§15, §48). Owner: the Chief of Staff — it is the
// readiness sweep across every specialist.
//
// Deterministic: nine reads over the coming week and sixty days of expiries,
// then the answer goes to the person who asked (or the parents when the asker
// has no login). The model may add a task per genuine gap it finds.
import { localTime, shiftDay, type WorkflowTemplate } from './index';

export const whatAmIForgettingTemplate: WorkflowTemplate = {
  intent: 'what_am_i_forgetting',
  agent: 'chief_of_staff',
  title: 'What am I forgetting?',
  deterministic: true,
  objective: () => 'Find what is slipping this week — unassigned events, unfinished prep, expiring documents, overdue chores, bills — and say so plainly.',
  guidance: [
    'Report gaps, not lists: an event with nobody assigned, homework due with no time set aside, a document expiring before a trip, a chore three days overdue, a budget already over.',
    'Add one tasks.createTodo per gap that needs a person to act (with an assignee and a due date); repeat as fix_gap, fix_gap_2 and so on. Never add a task for something already covered by a task or reminder in the context.',
    'Address the answer to the person who asked; use the parents only when the asker cannot be notified. Rewrite the notification body with the gaps found, most urgent first, in two or three sentences.',
  ],
  steps: [
    { key: 'events', stepType: 'retrieve', toolName: 'calendar.searchEvents', description: 'Read the coming week', input: (ctx) => ({ from: ctx.nowIso, to: localTime(shiftDay(ctx.todayKey, 7), 23, 59), limit: 100 }) },
    { key: 'conflicts', stepType: 'retrieve', toolName: 'calendar.findConflicts', description: 'Look for overlaps', input: (ctx) => ({ from: ctx.nowIso, to: localTime(shiftDay(ctx.todayKey, 7), 23, 59) }) },
    { key: 'homework', stepType: 'retrieve', toolName: 'school.listHomeworkDue', description: 'Check homework due', input: (ctx) => ({ from: ctx.nowIso, to: localTime(shiftDay(ctx.todayKey, 7), 23, 59) }) },
    { key: 'practices', stepType: 'retrieve', toolName: 'sports.listPracticesBetween', description: 'Check practices and games', input: (ctx) => ({ from: ctx.nowIso, to: localTime(shiftDay(ctx.todayKey, 7), 23, 59) }) },
    { key: 'todos', stepType: 'retrieve', toolName: 'tasks.searchTodos', description: 'Read the open to-dos', input: (ctx) => ({ done: false, due_before: shiftDay(ctx.todayKey, 7), limit: 50 }) },
    { key: 'chores', stepType: 'retrieve', toolName: 'tasks.listOpenChores', description: 'Read the chore board', input: () => ({ limit: 50 }) },
    { key: 'reminders', stepType: 'retrieve', toolName: 'reminders.listDue', description: 'See what reminders already cover', input: (ctx) => ({ before: localTime(shiftDay(ctx.todayKey, 7), 23, 59), limit: 50 }) },
    { key: 'expiring', stepType: 'retrieve', toolName: 'documents.expiringBefore', description: 'Check documents expiring soon', input: () => ({ within_days: 60 }) },
    { key: 'maintenance', stepType: 'retrieve', toolName: 'home.listOpenMaintenance', description: 'Check home tasks due', input: (ctx) => ({ due_before: localTime(shiftDay(ctx.todayKey, 14), 23, 59) }) },
    { key: 'budget', stepType: 'retrieve', toolName: 'finances.budgetVsActual', description: 'Check the month\'s budgets', input: (ctx) => ({ month: ctx.monthKey }), optional: true },
    {
      key: 'fix_gap', stepType: 'act', toolName: 'tasks.createTodo', description: 'Add a task for the gap that most needs a person',
      dependsOn: ['events', 'homework', 'practices', 'todos', 'chores', 'reminders', 'expiring', 'maintenance'],
      input: (ctx) => ({ title: '', due_date: ctx.tomorrowKey, priority: 'high' }),
      modelFills: 'title, assignee and due_date — one copy per genuine gap', optional: true,
    },
    {
      key: 'tell_asker', stepType: 'notify', description: 'Tell the person who asked what is slipping',
      dependsOn: ['events', 'conflicts', 'homework', 'practices', 'todos', 'chores', 'reminders', 'expiring', 'maintenance', 'budget'],
      input: (ctx) => ({
        recipients: ctx.viewerMemberId ? [ctx.viewerMemberId] : 'managers', type: 'system', title: 'Here is what is slipping this week',
        // The model rewrites this body with the gaps it found; without a model
        // (a routine) the sweep still lands with an honest pointer to the run.
        body: 'Bubaly checked the coming week, the chore board, expiring documents and home tasks. Open the run to see the gaps, most urgent first.',
      }),
    },
  ],
};
