// Tools for the routines a family sets up by asking (§19, §58).
//
// "Every Sunday, plan our meals" is one sentence that has to become a durable
// schedule, so `routines.create` parses the WHEN out of what they said and
// refuses when it cannot read it — the model then asks, instead of Bubaly
// inventing an hour nobody chose.
//
// These are `medium` risk on purpose. Creating a routine is not itself a
// household change, but it is a standing permission to ask on a cadence, and
// §12 is clear that standing permissions are the kind of thing a parent should
// see. Pausing one is `low`: stopping something is always safe.
import 'server-only';
import { z } from 'zod';
import { createRoutine, listRoutines, setRoutineEnabled } from '@/lib/services/routines';
import { ROUTINE_ANCHORS } from '@/lib/services/routines/anchors';
import { parseSchedule } from '@/lib/services/routines/schedule';
import { ok } from '@/lib/services/types';
import { defineTool, plural, type ToolDefinition } from './types';

const routineShape = z.object({
  id: z.string(),
  name: z.string(),
  said: z.string().nullable(),
  prompt: z.string(),
  enabled: z.boolean(),
  next_run_at: z.string().nullable(),
});

export const routineTools: ToolDefinition[] = [
  defineTool({
    name: 'routines.create',
    aliases: ['create_automation', 'create_routine', 'schedule_routine'],
    description: 'Set up a recurring routine from what the family said, e.g. "every Sunday plan our meals" or "two days before every trip make sure we are ready".',
    domain: 'scheduling',
    capability: 'automate',
    risk: 'medium',
    readOnly: false,
    // `automate` covers both setting a routine up and switching one off, so it
    // cannot say which happened; the household trail needs the difference.
    trailAction: 'create',
    input: z.object({
      when: z.string().describe('When it should run, in the family\'s words: "every Sunday at 5pm", "two days before every trip"'),
      prompt: z.string().describe('What Bubaly should do each time — the request it will make'),
      name: z.string().nullish().describe('A short name; defaults to the request'),
    }),
    output: z.object({ routine: routineShape }),
    idempotencyFrom: (input) => `routines.create:${input.when.trim().toLowerCase()}:${input.prompt.trim().toLowerCase()}`,
    summarize: (_input, output) => `Set up "${output.routine.name}"${output.routine.said ? ` — ${output.routine.said}` : ''}`,
    consequences: (input) => [
      `Bubaly will ask itself "${input.prompt}" ${input.when}.`,
      'Each run goes through the same approvals as a request you type yourself.',
    ],
    resource: (output) => ({ table: 'family_automation_rules', id: output.routine.id }),
    execute: async (scope, input) => {
      const res = await createRoutine(scope, { said: input.when, prompt: input.prompt, name: input.name ?? undefined });
      if (!res.ok) return res;
      const r = res.data;
      return ok({ routine: { id: r.id, name: r.name, said: r.said, prompt: r.prompt, enabled: r.enabled, next_run_at: r.nextRunAt } });
    },
  }),

  defineTool({
    name: 'routines.list',
    aliases: ['list_automations', 'list_routines'],
    description: 'List the family\'s recurring routines and when each next runs.',
    domain: 'scheduling',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ include_paused: z.boolean().nullish() }),
    output: z.object({ routines: z.array(routineShape) }),
    summarize: (_input, output) => (output.routines.length
      ? `${plural(output.routines.length, 'routine')} set up`
      : 'No routines set up yet'),
    execute: async (scope, input) => {
      const res = await listRoutines(scope, { includeDisabled: input.include_paused ?? false });
      if (!res.ok) return res;
      return ok({ routines: res.data.map((r) => ({ id: r.id, name: r.name, said: r.said, prompt: r.prompt, enabled: r.enabled, next_run_at: r.nextRunAt })) });
    },
  }),

  defineTool({
    name: 'routines.pause',
    aliases: ['pause_automation', 'stop_routine', 'resume_routine'],
    description: 'Pause a routine so it stops running, or resume a paused one.',
    domain: 'scheduling',
    capability: 'automate',
    risk: 'low',
    readOnly: false,
    // Pausing and resuming are both edits to a routine the family already has.
    trailAction: 'update',
    input: z.object({
      routine_id: z.string(),
      enabled: z.boolean().nullish().describe('False (the default) pauses it; true resumes it'),
    }),
    output: z.object({ routine: routineShape }),
    summarize: (_input, output) => (output.routine.enabled ? `Resumed "${output.routine.name}"` : `Paused "${output.routine.name}"`),
    consequences: (input) => [input.enabled ? 'The routine starts running again.' : 'The routine stops running until it is resumed.'],
    execute: async (scope, input) => {
      const res = await setRoutineEnabled(scope, input.routine_id, input.enabled ?? false);
      if (!res.ok) return res;
      const r = res.data;
      return ok({ routine: { id: r.id, name: r.name, said: r.said, prompt: r.prompt, enabled: r.enabled, next_run_at: r.nextRunAt } });
    },
  }),

  defineTool({
    name: 'routines.previewSchedule',
    aliases: ['preview_schedule', 'parse_schedule'],
    description: 'Check whether Bubaly can read a schedule before setting a routine up — use it when the family\'s wording is unusual.',
    domain: 'scheduling',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ when: z.string() }),
    output: z.object({
      understood: z.boolean(),
      kind: z.enum(['cron', 'relative']).nullable(),
      detail: z.string(),
    }),
    summarize: (_input, output) => output.detail,
    execute: async (_scope, input) => {
      const schedule = parseSchedule(input.when, ROUTINE_ANCHORS);
      if (!schedule) {
        return ok({
          understood: false, kind: null,
          detail: `Bubaly could not tell when "${input.when}" means. Ask for something like "every Sunday at 5pm" or "two days before every trip".`,
        });
      }
      return ok({
        understood: true,
        kind: schedule.kind,
        detail: schedule.kind === 'cron'
          ? `Understood as a repeating schedule (${schedule.expr}).`
          : `Understood as ${Math.abs(schedule.offsetDays)} ${Math.abs(schedule.offsetDays) === 1 ? 'day' : 'days'} ${schedule.offsetDays < 0 ? 'before' : 'after'} ${schedule.anchor.label}.`,
      });
    },
  }),
];
