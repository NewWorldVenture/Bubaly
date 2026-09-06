// The Daily Brief (§49). Owner: the Chief of Staff, the same voice that
// answers "what am I forgetting?" — this one is the morning version of it.
//
// Deterministic and READ-ONLY on purpose. A brief that quietly created things
// while telling you about your day would be the least trustworthy surface in
// the product: a person reads it half-awake, and anything it did would be
// something they did not ask for. So every step here is a read, and the one
// write is the notification that delivers it.
//
// There are TWO briefs, and this is the one a person asks for. The other —
// `lib/briefing/build.ts` — is deterministic, is what `/api/ai/briefing` files
// and what `/api/cron/daily-brief` delivers at 7am in the family's own zone,
// and needs no model at all. This template plans the narrated version: the same
// day, told rather than tabulated.
//
// This comment used to claim the two shared a composition. Nothing under
// `lib/ai/` imports `lib/briefing/build.ts`, and they never did.
import { localTime, shiftDay, type WorkflowTemplate } from './index';

export const dailyBriefTemplate: WorkflowTemplate = {
  intent: 'daily_brief',
  agent: 'chief_of_staff',
  title: 'Your day',
  deterministic: true,
  objective: () => 'Say what today holds, what needs a person, and what Bubaly has already handled.',
  guidance: [
    'This is a briefing: read everything, change nothing. Never add, move or cancel anything — if something needs doing, say so and let the family ask.',
    'Lead with what needs a person today, then what is already handled, then what is coming. Two or three sentences, in the order a person would want them.',
    'Name people and times as the family would say them ("Maya\'s practice at 4"), never ids.',
    'When the day is genuinely quiet, say so plainly rather than padding it.',
  ],
  steps: [
    { key: 'today', stepType: 'retrieve', toolName: 'calendar.searchEvents', description: "Read today's calendar", input: (ctx) => ({ from: localTime(ctx.todayKey, 0), to: localTime(ctx.todayKey, 23, 59), limit: 50 }) },
    { key: 'tomorrow', stepType: 'retrieve', toolName: 'calendar.searchEvents', description: 'Look at tomorrow, so nothing arrives unannounced', input: (ctx) => ({ from: localTime(ctx.tomorrowKey, 0), to: localTime(ctx.tomorrowKey, 23, 59), limit: 50 }) },
    { key: 'conflicts', stepType: 'retrieve', toolName: 'calendar.findConflicts', description: 'Check today for clashes', input: (ctx) => ({ from: localTime(ctx.todayKey, 0), to: localTime(ctx.todayKey, 23, 59) }) },
    { key: 'todos', stepType: 'retrieve', toolName: 'tasks.searchTodos', description: 'Read what is due', input: (ctx) => ({ done: false, due_before: ctx.tomorrowKey, limit: 50 }) },
    { key: 'chores', stepType: 'retrieve', toolName: 'tasks.listOpenChores', description: 'Read the chore board', input: () => ({ limit: 50 }) },
    { key: 'reminders', stepType: 'retrieve', toolName: 'reminders.listDue', description: 'See what reminders cover today', input: (ctx) => ({ before: localTime(ctx.todayKey, 23, 59), limit: 50 }) },
    { key: 'homework', stepType: 'retrieve', toolName: 'school.listHomeworkDue', description: 'Check homework due', input: (ctx) => ({ from: localTime(ctx.todayKey, 0), to: localTime(shiftDay(ctx.todayKey, 2), 23, 59) }), optional: true },
    { key: 'meals', stepType: 'retrieve', toolName: 'meals.getMealPlan', description: 'See what dinner is', input: (ctx) => ({ week_start: ctx.weekStartKey }), optional: true },
    { key: 'expiring', stepType: 'retrieve', toolName: 'documents.expiringBefore', description: 'Check anything about to expire', input: () => ({ within_days: 30 }), optional: true },
    {
      key: 'tell_asker', stepType: 'notify', description: 'Deliver the brief',
      dependsOn: ['today', 'tomorrow', 'conflicts', 'todos', 'chores', 'reminders', 'homework', 'meals', 'expiring'],
      input: (ctx) => ({
        recipients: ctx.viewerMemberId ? [ctx.viewerMemberId] : 'managers', type: 'system', title: 'Your day',
        // The model rewrites this body from what the reads found. Without a
        // model (a scheduled routine with the stub) the brief still lands with
        // an honest pointer rather than a fabricated summary.
        body: 'Bubaly looked at today: the calendar, what is due, the chore board and anything expiring. Open the run to see the details.',
      }),
    },
  ],
};
