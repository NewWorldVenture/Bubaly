// Workflow F — Remind everyone (§18). Owner: the Communications Assistant.
//
// The rule that matters is "avoid blasting irrelevant people": the reads find
// out who has something tomorrow, and the model writes one notification per
// person who does — never one to the whole family unless everyone is
// involved.
import { localTime, type WorkflowTemplate } from './index';

export const remindEveryoneTemplate: WorkflowTemplate = {
  intent: 'remind_everyone',
  agent: 'comms_assistant',
  title: 'Remind everyone about tomorrow',
  deterministic: false,
  objective: (ctx) => `Make sure everyone knows what they need to do before ${ctx.tomorrowKey}.`,
  guidance: [
    'Send one notification per person who has something tomorrow — an event, a practice, homework, a chore, a task — naming exactly what it is and what to bring or finish. Repeat the tell_person step as tell_person_2, tell_person_3 and so on, each with `audience:"members"` and one name in `member_names`.',
    'Do not notify anyone with nothing tomorrow. Use `audience:"family"` only when the reminder genuinely applies to everyone.',
    'Add a reminder for anything that must happen at a specific time tomorrow (a pickup, a form due, equipment to pack).',
    'Managed profiles without a login cannot be notified: address their reminder to a parent instead.',
  ],
  steps: [
    { key: 'members', stepType: 'retrieve', toolName: 'family.listMembers', description: 'See who is in the household', input: () => ({}) },
    { key: 'tomorrow_events', stepType: 'retrieve', toolName: 'calendar.searchEvents', description: 'Read tomorrow\'s calendar', input: (ctx) => ({ from: localTime(ctx.tomorrowKey, 0), to: localTime(ctx.tomorrowKey, 23, 59), limit: 50 }) },
    { key: 'homework', stepType: 'retrieve', toolName: 'school.listHomeworkDue', description: 'Check homework due tomorrow', input: (ctx) => ({ from: ctx.nowIso, to: localTime(ctx.dayAfterTomorrowKey, 0) }) },
    { key: 'practices', stepType: 'retrieve', toolName: 'sports.listPracticesBetween', description: 'Check tomorrow\'s practices and games', input: (ctx) => ({ from: localTime(ctx.tomorrowKey, 0), to: localTime(ctx.tomorrowKey, 23, 59) }) },
    { key: 'school_events', stepType: 'retrieve', toolName: 'school.listEventsBetween', description: 'Check tomorrow\'s school events', input: (ctx) => ({ from: localTime(ctx.tomorrowKey, 0), to: localTime(ctx.tomorrowKey, 23, 59) }) },
    { key: 'todos', stepType: 'retrieve', toolName: 'tasks.searchTodos', description: 'Read what is still to do', input: (ctx) => ({ done: false, due_before: ctx.tomorrowKey, limit: 50 }) },
    { key: 'chores', stepType: 'retrieve', toolName: 'tasks.listOpenChores', description: 'Read the chore board', input: () => ({ limit: 50 }) },
    { key: 'due_reminders', stepType: 'retrieve', toolName: 'reminders.listDue', description: 'See which reminders already cover tomorrow', input: (ctx) => ({ before: localTime(ctx.dayAfterTomorrowKey, 0), limit: 50 }) },
    {
      key: 'tell_person', stepType: 'act', toolName: 'notifications.notify', description: 'Tell one person exactly what they need tomorrow',
      dependsOn: ['members', 'tomorrow_events', 'homework', 'practices', 'school_events', 'todos', 'chores', 'due_reminders'],
      input: () => ({ title: '', body: '', audience: 'members', member_names: [], type: 'system' }),
      modelFills: 'title, body and member_names (one person) — one copy of this step per person with something tomorrow',
    },
    {
      key: 'timed_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Set a reminder for the thing with a fixed time',
      dependsOn: ['tomorrow_events', 'practices', 'school_events'], input: (ctx) => ({ title: '', remind_at: localTime(ctx.tomorrowKey, 7, 30), kind: 'time' }),
      modelFills: 'title and remind_at, and assignee when it is for one person', optional: true,
    },
  ],
};
