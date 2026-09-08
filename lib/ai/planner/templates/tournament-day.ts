// Workflow — Tournament day (M25). Owner: the Scheduler, because a tournament
// is a whole day that eats a calendar: several games, a call time hours before
// the first one, a drive, food between rounds, and the rest of the family's
// Saturday still to happen around it.
//
// The template plans ONE day. The day is `entities.day` when the request named
// one and the coming weekend's Saturday otherwise — a tournament is almost
// always a weekend, and guessing "today" would put the prep reminder in the
// past.
import { localTime, shiftDay, type TemplateContext, type WorkflowTemplate } from './index';

/** The tournament day: the one the request named, else the coming Saturday. */
export function tournamentDayKey(ctx: TemplateContext): string {
  const named = (ctx.entities.day ?? ctx.entities.date ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(named) ? named : ctx.weekendStartKey;
}

export const tournamentDayTemplate: WorkflowTemplate = {
  intent: 'tournament_day',
  agent: 'scheduler',
  title: 'Run the tournament day',
  deterministic: false,
  objective: (ctx) => `Get the family through the tournament on ${tournamentDayKey(ctx)}: call time, kit, food, driving and everything else that day still needs.`,
  guidance: [
    'Read the practices, the calendar and the teams first; never invent a game time the context does not show.',
    'The call time is the earliest game time in the context minus the warm-up the team keeps (an hour when nothing says otherwise). Put ONE calendar block on the day covering the whole tournament, not one per round.',
    'Give the player a kit task and the driver a task of their own; repeat kit_task as kit_task_2 for a second player.',
    'The night-before reminder names the kit, the food and the leave-by time in one sentence.',
    'If the context shows no game or practice on that day, keep only the reads, say so in the reasoning summary, and drop every act step rather than planning a day that is not happening.',
  ],
  steps: [
    { key: 'members', stepType: 'retrieve', toolName: 'family.listMembers', description: 'Confirm who is playing and who is free to drive', input: () => ({}) },
    { key: 'teams', stepType: 'retrieve', toolName: 'sports.listTeams', description: 'Read the teams on record', input: () => ({}) },
    { key: 'games', stepType: 'retrieve', toolName: 'sports.listPracticesBetween', description: 'Read the games and practices that day', input: (ctx) => ({ from: localTime(tournamentDayKey(ctx), 0), to: localTime(tournamentDayKey(ctx), 23, 59) }) },
    { key: 'events', stepType: 'retrieve', toolName: 'calendar.searchEvents', description: 'Read what else is already on that day', input: (ctx) => ({ from: localTime(tournamentDayKey(ctx), 0), to: localTime(tournamentDayKey(ctx), 23, 59), limit: 50 }) },
    { key: 'conflicts', stepType: 'retrieve', toolName: 'calendar.findConflicts', description: 'Look for clashes with the tournament', input: (ctx) => ({ from: localTime(tournamentDayKey(ctx), 0), to: localTime(tournamentDayKey(ctx), 23, 59) }) },
    { key: 'kit_memory', stepType: 'retrieve', toolName: 'memory.recall', description: 'Recall what this family packs for a tournament', input: () => ({ category: 'preference', query: 'tournament', limit: 20 }) },
    {
      key: 'block_day', stepType: 'act', toolName: 'calendar.createEvent', description: 'Block the tournament on the family calendar',
      dependsOn: ['games', 'events', 'conflicts'],
      input: (ctx) => ({ title: '', starts_at: localTime(tournamentDayKey(ctx), 8), ends_at: localTime(tournamentDayKey(ctx), 17), category: 'sports' }),
      modelFills: 'title (team and venue) and starts_at/ends_at from the first and last game in the context',
    },
    {
      key: 'kit_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Give the player the kit to pack',
      dependsOn: ['games', 'kit_memory', 'members'],
      input: (ctx) => ({ title: '', due_date: shiftDay(tournamentDayKey(ctx), -1), priority: 'high' }),
      modelFills: 'title listing the kit, and the player (or their parent) as assignee',
    },
    {
      key: 'food_task', stepType: 'act', toolName: 'tasks.createTodo', description: 'Sort the food for the day',
      dependsOn: ['games'],
      input: (ctx) => ({ title: 'Pack food and water for the tournament', due_date: shiftDay(tournamentDayKey(ctx), -1), priority: 'medium' }),
      optional: true,
    },
    {
      key: 'driving_reminder', stepType: 'act', toolName: 'reminders.create', description: 'Remind the driver the evening before',
      dependsOn: ['block_day', 'kit_task'],
      input: (ctx) => ({ title: '', remind_at: localTime(shiftDay(tournamentDayKey(ctx), -1), 19), kind: 'time', priority: 'high' }),
      modelFills: 'title naming the leave-by time, the venue and what goes in the car',
    },
    {
      key: 'check_day', stepType: 'verify', description: 'Check the day is really blocked and the reminder is set',
      dependsOn: ['block_day', 'driving_reminder'],
      input: () => ({
        checks: [
          { kind: 'records_exist', table: 'calendar_events', ids: [{ $fromStep: 'block_day', path: 'id' }], label: 'The tournament is on the calendar' },
          { kind: 'records_exist', table: 'family_reminders', ids: [{ $fromStep: 'driving_reminder', path: 'id' }], label: 'The night-before reminder is set' },
        ],
      }),
    },
    {
      key: 'tell_family', stepType: 'notify', description: 'Share the tournament-day plan',
      dependsOn: ['check_day', 'food_task'],
      input: () => ({ recipients: 'family', type: 'calendar_event', title: 'Tournament day is planned', body: '' }),
      modelFills: 'body: call time, who drives, what to pack, and what else on the day had to move',
    },
  ],
};
