// Workflow C — Organize our weekend (§18). Owner: the Scheduler, because the
// weekend is a calendar problem first: what is fixed, what clashes, where the
// free blocks are — and only then what to put in them.
import { localTime, type WorkflowTemplate } from './index';

export const organizeWeekendTemplate: WorkflowTemplate = {
  intent: 'organize_weekend',
  agent: 'scheduler',
  title: 'Organize the weekend',
  deterministic: false,
  objective: (ctx) => `Organize the weekend of ${ctx.weekendStartKey}–${ctx.weekendEndKey}: fixed commitments, a realistic agenda, and the prep it needs.`,
  guidance: [
    'Treat practices, games, school events and existing calendar entries as fixed; build the agenda around them.',
    'Add at most two or three activities the family actually likes (use the preferences and memory facts in the context), each in a free slot from the context, each as its own calendar.createEvent step with keys add_activity, add_activity_2 and so on.',
    'Every activity that needs preparation gets one task with an assignee; a fixed commitment that needs a ride or equipment gets a reminder the evening before.',
    'Never create an event that overlaps an existing one.',
  ],
  steps: [
    { key: 'members', stepType: 'retrieve', toolName: 'family.listMembers', description: 'Confirm who is home this weekend', input: () => ({}) },
    { key: 'events', stepType: 'retrieve', toolName: 'calendar.searchEvents', description: 'Read what is already on the weekend calendar', input: (ctx) => ({ from: localTime(ctx.weekendStartKey, 0), to: localTime(ctx.weekendEndKey, 23, 59), limit: 50 }) },
    { key: 'conflicts', stepType: 'retrieve', toolName: 'calendar.findConflicts', description: 'Look for weekend clashes', input: (ctx) => ({ from: localTime(ctx.weekendStartKey, 0), to: localTime(ctx.weekendEndKey, 23, 59) }) },
    { key: 'practices', stepType: 'retrieve', toolName: 'sports.listPracticesBetween', description: 'Check games and practices', input: (ctx) => ({ from: localTime(ctx.weekendStartKey, 0), to: localTime(ctx.weekendEndKey, 23, 59) }) },
    { key: 'school', stepType: 'retrieve', toolName: 'school.listEventsBetween', description: 'Check school events', input: (ctx) => ({ from: localTime(ctx.weekendStartKey, 0), to: localTime(ctx.weekendEndKey, 23, 59) }), optional: true },
    { key: 'todos', stepType: 'retrieve', toolName: 'tasks.searchTodos', description: 'Read the errands still open', input: (ctx) => ({ done: false, due_before: ctx.weekendEndKey, limit: 30 }) },
    { key: 'likes', stepType: 'retrieve', toolName: 'memory.recall', description: 'Recall what the family likes doing', input: () => ({ category: 'preference', query: 'weekend', limit: 20 }) },
    { key: 'free_slots', stepType: 'retrieve', toolName: 'calendar.findFreeSlots', description: 'Find the free blocks', input: (ctx) => ({ duration_min: 120, from: localTime(ctx.weekendStartKey, 9), to: localTime(ctx.weekendEndKey, 19), start_hour: 9, end_hour: 19, limit: 6 }) },
    {
      key: 'add_activity', stepType: 'act', toolName: 'calendar.createEvent', description: 'Put the main activity on the calendar',
      dependsOn: ['events', 'conflicts', 'practices', 'free_slots', 'likes'],
      input: () => ({ title: '', starts_at: '', ends_at: '', category: 'general' }),
      modelFills: 'title, starts_at and ends_at from a free slot, and assignee when it is for one person',
    },
    {
      key: 'prep_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Add the prep the weekend needs',
      dependsOn: ['add_activity', 'todos'], input: (ctx) => ({ title: '', due_date: ctx.weekendStartKey, priority: 'medium' }),
      modelFills: 'title and assignee', optional: true,
    },
    {
      key: 'evening_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Remind everyone the evening before',
      dependsOn: ['events', 'practices'], input: (ctx) => ({ title: '', remind_at: localTime(ctx.weekendStartKey, 19), kind: 'time' }),
      modelFills: 'title naming what to bring or where to be, and remind_at the evening before it', optional: true,
    },
    {
      key: 'check_clashes', stepType: 'verify', description: 'Make sure nothing on the weekend overlaps',
      dependsOn: ['add_activity'],
      input: (ctx) => ({ checks: [{ kind: 'no_calendar_conflicts', start: localTime(ctx.weekendStartKey, 0), end: localTime(ctx.weekendEndKey, 23, 59), label: 'No weekend overlaps' }] }),
    },
    {
      key: 'tell_family', stepType: 'notify', description: 'Share the weekend plan',
      dependsOn: ['check_clashes', 'prep_task', 'evening_reminder'],
      input: () => ({ recipients: 'family', type: 'calendar_event', title: 'The weekend plan is set', body: '' }),
      modelFills: 'body: the agenda in two or three sentences, with who is doing what',
    },
  ],
};
