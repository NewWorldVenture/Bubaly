// Workflow — School morning (M25). Owner: the School Coordinator.
//
// The morning is the most repeated hard problem a household has, and almost
// none of it is decided at 7am: the timetable, the kit, the lunches and the
// leave-by time are all knowable the night before. So this template plans the
// EVENING before the school day, and leaves exactly one thing to the morning —
// the reminder that fires while everyone is still in the kitchen.
import { localTime, shiftDay, weekdayOf, type TemplateContext, type WorkflowTemplate } from './index';

/** The school day being planned: the named day, else the next weekday (never a Saturday or Sunday). */
export function schoolDayKey(ctx: TemplateContext): string {
  const named = (ctx.entities.day ?? ctx.entities.date ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(named)) return named;
  let day = ctx.tomorrowKey;
  for (let i = 0; i < 7; i += 1) {
    const weekday = weekdayOf(day);
    if (weekday >= 1 && weekday <= 5) return day;
    day = shiftDay(day, 1);
  }
  return ctx.tomorrowKey;
}

export const schoolMorningTemplate: WorkflowTemplate = {
  intent: 'school_morning',
  agent: 'school_coordinator',
  title: 'Set up the school morning',
  deterministic: false,
  objective: (ctx) => `Make the morning of ${schoolDayKey(ctx)} run itself: who needs what, packed the night before, and one reminder at the right hour.`,
  guidance: [
    'Plan the EVENING before. Everything except the wake-up reminder is a task due the night before.',
    'One packing task per child, keyed pack_bag, pack_bag_2 and so on, each naming that child\'s classes, kit and anything due — never one task for "the kids".',
    'The morning reminder fires once, an hour before the earliest leave-by time in the context, and names the leave-by time.',
    'Use the homework and the timetable in the context; do not invent a lesson, a lunch or a club that is not there.',
    'Drop the lunch step when the context shows the school provides lunch or the family already planned it.',
  ],
  steps: [
    { key: 'members', stepType: 'retrieve', toolName: 'family.listMembers', description: 'Confirm who is going to school', input: () => ({}) },
    { key: 'timetable', stepType: 'retrieve', toolName: 'school.listClasses', description: 'Read the timetable for that day', input: (ctx) => ({ day_of_week: weekdayOf(schoolDayKey(ctx)), for_date: schoolDayKey(ctx) }) },
    { key: 'homework', stepType: 'retrieve', toolName: 'school.listHomeworkDue', description: 'Read the homework due', input: (ctx) => ({ from: localTime(ctx.todayKey, 0), to: localTime(schoolDayKey(ctx), 23, 59) }) },
    { key: 'school_events', stepType: 'retrieve', toolName: 'school.listEventsBetween', description: 'Check for school events that day', input: (ctx) => ({ from: localTime(schoolDayKey(ctx), 0), to: localTime(schoolDayKey(ctx), 23, 59) }), optional: true },
    { key: 'practices', stepType: 'retrieve', toolName: 'sports.listPracticesBetween', description: 'Check practices before or after school', input: (ctx) => ({ from: localTime(schoolDayKey(ctx), 0), to: localTime(schoolDayKey(ctx), 23, 59) }), optional: true },
    { key: 'events', stepType: 'retrieve', toolName: 'calendar.searchEvents', description: 'Read what else is on that morning', input: (ctx) => ({ from: localTime(schoolDayKey(ctx), 0), to: localTime(schoolDayKey(ctx), 12), limit: 30 }) },
    { key: 'routines', stepType: 'retrieve', toolName: 'memory.recall', description: 'Recall how this family does mornings', input: () => ({ category: 'preference', query: 'morning', limit: 20 }) },
    {
      key: 'pack_bag', stepType: 'act', toolName: 'tasks.createTodo', description: 'Pack one child\'s bag the night before',
      dependsOn: ['timetable', 'homework', 'practices', 'members'],
      input: (ctx) => ({ title: '', due_date: shiftDay(schoolDayKey(ctx), -1), priority: 'high' }),
      modelFills: 'title listing that child\'s books, kit and homework, and the child (or their parent) as assignee',
    },
    {
      key: 'lunch_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Make the lunches the night before',
      dependsOn: ['members', 'school_events'],
      input: (ctx) => ({ title: 'Make the lunches for tomorrow', due_date: shiftDay(schoolDayKey(ctx), -1), priority: 'medium' }),
      optional: true,
    },
    {
      key: 'morning_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Remind everyone in the morning',
      dependsOn: ['events', 'timetable', 'pack_bag'],
      input: (ctx) => ({ title: '', remind_at: localTime(schoolDayKey(ctx), 7), kind: 'time', priority: 'high' }),
      modelFills: 'title naming the leave-by time and what goes in the car, and remind_at an hour before it',
    },
    {
      key: 'check_morning', stepType: 'verify', description: 'Check the packing task and the reminder really exist',
      dependsOn: ['pack_bag', 'morning_reminder'],
      input: () => ({
        checks: [
          { kind: 'records_exist', table: 'todo_items', ids: [{ $fromStep: 'pack_bag', path: 'id' }], label: 'The bag is on someone\'s list' },
          { kind: 'records_exist', table: 'family_reminders', ids: [{ $fromStep: 'morning_reminder', path: 'id' }], label: 'The morning reminder is set' },
        ],
      }),
    },
    {
      key: 'tell_family', stepType: 'notify', description: 'Tell the family how the morning is set up',
      dependsOn: ['check_morning', 'lunch_task'],
      input: () => ({ recipients: 'family', type: 'system', title: 'Tomorrow morning is set up', body: '' }),
      modelFills: 'body: the leave-by time, who packs what tonight, and anything unusual about that day',
    },
  ],
};
