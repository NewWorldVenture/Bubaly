// The family's notepad and its shared goals.
//
// Both live here because both are "write down something the household wants to
// keep", and both carry trust domain `tasks` — there is no `notes` or `goals`
// trust domain (`lib/trust/engine.ts` TRUST_DOMAINS), and inventing one would
// give families a permission switch that governs nothing else.
//
// WHY THESE EXIST AT ALL, AND WHY THE ALIASES ARE LOAD-BEARING:
//
// `add_note` and `add_goal` are gated in chat by `lib/assistant/trust-wrapper.ts`.
// A gate that fires stores `{name, args}` on the approval row, and
// `approveRequest` replays it with `executeTool(scope, name, args)` — which
// resolves the name through THIS registry. With no entry, a parent could grant
// the approval and read back "Bubaly has no tool called \"add_note\"".
//
// The aliases below are what make that replay resolve, and they are also the
// only thing keeping the chat toolbox unchanged. `assistant-engine.ts` excludes
// a registry tool from the model's toolbox when `getTool(flatName)` resolves:
//
//     const covered = new Set([...assistantTools, ...actionTools].map((t) => getTool(t.name)?.name)…)
//     toToolSpecs(scope, { names: toolNames().filter((n) => !covered.has(n)) })
//
// `mergeToolSets` dedupes on the WIRE name, and the registry's wire name is
// `notes_create` — a different string from `add_note`, which it could never see
// as the same tool. So `covered`, and therefore the alias, is the whole
// mechanism. Drop or misspell an alias here and the model is offered BOTH
// spellings of one capability, gated two different ways and ledgered only on
// one path. `tests/assistant-approval-replay.test.ts` guards it.
//
// RISK IS `medium` ON PURPOSE. `lib/trust/ai-gate.ts` reads
// `registryTool ? effectiveRisk(settings, registryTool) : 'medium'`, so before
// these tools existed the chat gate used a hard-coded `medium` for both names.
// Declaring `low` — which every other `tasks.*` tool declares — would quietly
// LOOSEN the gate for children and teens the day this merged. Keeping `medium`
// makes the chat gate byte-identical; changing it is a separate decision a
// family should get to see.
import 'server-only';
import { z } from 'zod';
import { createNote } from '@/lib/services/notes';
import { createGoal } from '@/lib/services/goals';
import { defineTool, type ToolDefinition } from './types';

const noteOutput = z.object({
  id: z.string(),
  title: z.string().nullable(),
  body: z.string(),
});

const goalOutput = z.object({
  id: z.string(),
  title: z.string(),
  target_date: z.string().nullable(),
  progress: z.number(),
});

export const noteTools: ToolDefinition[] = [
  defineTool({
    name: 'notes.create',
    aliases: ['add_note', 'save_note'],
    description: 'Save a note on the family noticeboard — something the household wants written down.',
    domain: 'tasks',
    capability: 'create',
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      title: z.string().nullish().describe('Optional heading'),
      body: z.string().describe('What the note says'),
    }),
    output: noteOutput,
    // No natural key. Two notes with the same words are two notes — a family
    // that writes "bins go out Tuesday" twice has written it twice, and there
    // is nothing here that a duplicate guard would be protecting. Inside a run
    // this falls through to `scopeKey`'s full argument hash, so a RETRIED step
    // is still deduplicated; on a bare chat turn nothing is. That is the same
    // choice `finances.createTransaction` makes, and for the same reason: a key
    // that cannot tell two real requests apart deletes one of them.
    idempotencyFrom: () => null,
    summarize: (_input, output) => (output.title ? `Saved the note "${output.title}"` : 'Saved a family note'),
    resource: (output) => ({ table: 'notes', id: output.id }),
    execute: async (scope, input) => {
      const res = await createNote(scope, { title: input.title ?? null, body: input.body });
      if (!res.ok) return res;
      return { ok: true, data: { id: res.data.id, title: res.data.title, body: res.data.body } };
    },
  }),

  defineTool({
    name: 'goals.create',
    aliases: ['add_goal', 'create_goal'],
    description: 'Create a family goal, optionally with a target date, that the household is working towards.',
    domain: 'tasks',
    capability: 'create',
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      title: z.string().describe('What the family is working towards'),
      description: z.string().nullish(),
      target_date: z.string().nullish().describe('Calendar day, YYYY-MM-DD'),
      progress: z.number().nullish().describe('Percent complete, 0-100. Defaults to 0'),
    }),
    output: goalOutput,
    idempotencyFrom: () => null,
    summarize: (_input, output) => `Created the goal "${output.title}"${output.target_date ? ` for ${output.target_date}` : ''}`,
    resource: (output) => ({ table: 'goals', id: output.id }),
    execute: async (scope, input) => {
      const res = await createGoal(scope, {
        title: input.title,
        description: input.description ?? null,
        targetDate: input.target_date ?? null,
        progress: input.progress ?? null,
      });
      if (!res.ok) return res;
      return {
        ok: true,
        data: { id: res.data.id, title: res.data.title, target_date: res.data.target_date, progress: res.data.progress },
      };
    },
  }),
];
