// Move Planner tools — the concierge half of "we're moving in October".
//
// A move is a ten-week project with a fixed deadline, and the template in
// `lib/moving/planner.ts` already knows every task a family forgets. These
// tools let a plan put the move on file, lay the template out as dated tasks,
// add the specific ones live data calls for (one address change per tracked
// subscription, one records request per school, one vet visit per pet) and,
// when the date slips, shift the whole timeline through the reviewed
// recalculation the page uses.
//
// Risk tiers: putting a move on file and adding tasks are `low` — reversible
// rows on the family's own planner. Changing the date is `medium`: it rewrites
// every open relative task's due date in one go, which a parent should see.
//
// Trust domain: `home_maintenance`, for the same reason the inventory tools
// use it — there is no moving domain and the taxonomy is closed.
import 'server-only';
import { z } from 'zod';
import { MOVE_KINDS, TASK_CATEGORIES } from '@/lib/moving/planner';
import { addTask, createMove, getMove, planTasks, setMoveDate } from '@/lib/services/moving';
import { ok } from '@/lib/services/types';
import { resolveAssigneeId } from './family';
import { defineTool, plural, type ToolDefinition } from './types';

const KIND_VALUES = MOVE_KINDS.map((k) => k.value) as [string, ...string[]];
const CATEGORY_VALUES = TASK_CATEGORIES.map((c) => c.value) as [string, ...string[]];

const moveShape = z.object({
  id: z.string(),
  title: z.string(),
  move_date: z.string(),
  status: z.string(),
  move_kind: z.string(),
  from_address: z.string().nullable(),
  to_address: z.string().nullable(),
  has_kids: z.boolean(),
  has_pets: z.boolean(),
});

const taskShape = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  offset_days: z.number().int(),
  due_date: z.string().nullable(),
  status: z.string(),
  assignee_id: z.string().nullable(),
  template_key: z.string().nullable(),
});

type MoveRowLike = { id: string; title: string; move_date: string; status: string; move_kind: string; from_address: string | null; to_address: string | null; has_kids: boolean; has_pets: boolean };
type TaskRowLike = { id: string; title: string; category: string; offset_days: number; due_date: string | null; status: string; assignee_id: string | null; template_key: string | null };

const toMove = (m: MoveRowLike) => ({ id: m.id, title: m.title, move_date: m.move_date, status: m.status, move_kind: m.move_kind, from_address: m.from_address, to_address: m.to_address, has_kids: m.has_kids, has_pets: m.has_pets });
const toTask = (t: TaskRowLike) => ({ id: t.id, title: t.title, category: t.category, offset_days: t.offset_days, due_date: t.due_date, status: t.status, assignee_id: t.assignee_id, template_key: t.template_key });

export const movingTools: ToolDefinition[] = [
  defineTool({
    name: 'moving.getMove',
    aliases: ['get_move', 'move_status', 'move_plan'],
    description: 'The family\'s move on file (or a specific one by id) with its dated tasks and how far along it is. Use it before planning or changing anything about the move.',
    domain: 'home_maintenance',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ move_id: z.string().nullish().describe('Omit for the family\'s current move') }),
    output: z.object({
      found: z.boolean(),
      move: moveShape.nullable(),
      tasks: z.array(taskShape),
      days_to_move: z.number().int().nullable(),
      open: z.number().int(),
      done: z.number().int(),
      overdue: z.number().int(),
      summary: z.string(),
    }),
    summarize: (_input, output) => (output.found && output.move ? `${output.move.title}: ${output.summary}` : 'No move on file'),
    execute: async (scope, input) => {
      const res = await getMove(scope, { moveId: input.move_id ?? null });
      if (!res.ok) return res;
      if (!res.data) return ok({ found: false, move: null, tasks: [], days_to_move: null, open: 0, done: 0, overdue: 0, summary: 'No move on file' });
      const { move, tasks, summary } = res.data;
      return ok({
        found: true, move: toMove(move), tasks: tasks.map(toTask),
        days_to_move: summary.daysToMove, open: summary.total - summary.done, done: summary.done, overdue: summary.overdue, summary: summary.text,
      });
    },
  }),

  defineTool({
    name: 'moving.createMove',
    aliases: ['create_move', 'put_move_on_file', 'start_move'],
    description: 'Put a move on file: a title, the move date and where from / to. Returns the existing move when the family already has one under way.',
    domain: 'home_maintenance',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      title: z.string().nullish().describe('e.g. "Move to Maple Street"'),
      move_date: z.string().nullish().describe('YYYY-MM-DD; defaults to 45 days out'),
      from_address: z.string().nullish(),
      to_address: z.string().nullish(),
      move_kind: z.enum(KIND_VALUES).nullish(),
      has_kids: z.boolean().nullish().describe('Omit to read it from the roster'),
      has_pets: z.boolean().nullish().describe('Omit to read it from the pets on file'),
      is_renting_out: z.boolean().nullish(),
      notes: z.string().nullish(),
    }),
    output: z.object({ move: moveShape, created: z.boolean() }),
    idempotencyFrom: (input) => `moving.createMove:${(input.title ?? '').trim().toLowerCase()}:${input.move_date ?? ''}`,
    summarize: (_input, output) => (output.created ? `Put "${output.move.title}" on file for ${output.move.move_date}` : `"${output.move.title}" is already on file for ${output.move.move_date}`),
    consequences: () => ['A move appears in the Move Planner with its date; tasks are added separately.'],
    resource: (output) => ({ table: 'moves', id: output.move.id }),
    execute: async (scope, input) => {
      const res = await createMove(scope, {
        title: input.title ?? null, moveDate: input.move_date ?? null, fromAddress: input.from_address ?? null, toAddress: input.to_address ?? null,
        moveKind: input.move_kind ?? null, hasKids: input.has_kids ?? null, hasPets: input.has_pets ?? null, isRentingOut: input.is_renting_out ?? null, notes: input.notes ?? null,
      });
      if (!res.ok) return res;
      return ok({ move: toMove(res.data.move), created: res.data.created });
    },
  }),

  defineTool({
    name: 'moving.planTasks',
    aliases: ['plan_move_tasks', 'generate_move_checklist'],
    description: 'Lay the standard moving timeline (8 weeks before to 2 weeks after) out as dated tasks for the move, adding only the ones it does not have yet.',
    domain: 'home_maintenance',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({ move_id: z.string().nullish().describe('Omit for the family\'s current move') }),
    output: z.object({ move_id: z.string(), added: z.number().int(), already_planned: z.number().int(), tasks: z.array(taskShape) }),
    idempotencyFrom: (input) => `moving.planTasks:${input.move_id ?? 'current'}`,
    summarize: (_input, output) => (output.added === 0
      ? `The move timeline was already in place (${plural(output.already_planned, 'task')})`
      : `Added ${plural(output.added, 'dated move task')}${output.already_planned ? `; ${output.already_planned} were already there` : ''}`),
    consequences: () => ['Dated tasks appear in the Move Planner, each due a set number of days before or after move day.'],
    resource: (output) => ({ table: 'moves', id: output.move_id }),
    execute: async (scope, input) => {
      const res = await planTasks(scope, { moveId: input.move_id ?? null });
      if (!res.ok) return res;
      return ok({ move_id: res.data.move.id, added: res.data.inserted.length, already_planned: res.data.alreadyPlanned, tasks: res.data.inserted.map(toTask) });
    },
  }),

  defineTool({
    name: 'moving.addTask',
    aliases: ['add_move_task'],
    description: 'Add one task to the move, e.g. "Change address with Netflix" — with days before/after move day so it follows a date change, or a fixed date. A template_key keeps it from being added twice.',
    domain: 'home_maintenance',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      title: z.string(),
      category: z.enum(CATEGORY_VALUES).nullish(),
      offset_days: z.number().int().nullish().describe('Days relative to move day: negative before, positive after'),
      due_date: z.string().nullish().describe('YYYY-MM-DD, when the task has a fixed date instead'),
      assignee: z.string().nullish().describe('Family member name'),
      assignee_id: z.string().nullish(),
      template_key: z.string().nullish().describe('A stable key so a re-plan never adds this task twice'),
      notes: z.string().nullish(),
      move_id: z.string().nullish().describe('Omit for the family\'s current move'),
    }),
    output: z.object({ task: taskShape, created: z.boolean() }),
    idempotencyFrom: (input) => `moving.addTask:${(input.template_key ?? input.title).trim().toLowerCase()}:${input.move_id ?? 'current'}`,
    summarize: (_input, output) => (output.created
      ? `Added "${output.task.title}" to the move${output.task.due_date ? ` — due ${output.task.due_date}` : ''}`
      : `"${output.task.title}" was already on the move`),
    resource: (output) => ({ table: 'move_tasks', id: output.task.id }),
    execute: async (scope, input) => {
      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;
      const res = await addTask(scope, {
        moveId: input.move_id ?? null, title: input.title, category: input.category ?? null, offsetDays: input.offset_days ?? null, dueDate: input.due_date ?? null,
        assigneeId: assignee.data, templateKey: input.template_key ?? null, notes: input.notes ?? null,
      });
      if (!res.ok) return res;
      return ok({ task: toTask(res.data.task), created: res.data.created });
    },
  }),

  defineTool({
    name: 'moving.setMoveDate',
    aliases: ['set_move_date', 'change_move_date', 'reschedule_move'],
    description: 'Change the move date. Every open task dated relative to move day shifts with it; done, skipped and fixed-date tasks keep their dates.',
    domain: 'home_maintenance',
    capability: 'edit',
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      date: z.string().describe('The new move date, YYYY-MM-DD'),
      move_id: z.string().nullish().describe('Omit for the family\'s current move'),
    }),
    output: z.object({ move: moveShape, from_date: z.string(), to_date: z.string(), shifted: z.number().int(), preserved: z.number().int() }),
    idempotencyFrom: (input) => `moving.setMoveDate:${input.move_id ?? 'current'}:${input.date}`,
    summarize: (_input, output) => `Moved "${output.move.title}" from ${output.from_date} to ${output.to_date}${output.shifted ? `, shifting ${plural(output.shifted, 'task')}` : ''}`,
    consequences: (input) => [
      `The move date becomes ${input.date}.`,
      'Every open task that is dated relative to move day moves with it; finished, skipped and fixed-date tasks stay where they are.',
    ],
    resource: (output) => ({ table: 'moves', id: output.move.id }),
    execute: async (scope, input) => {
      const res = await setMoveDate(scope, { moveId: input.move_id ?? null, date: input.date });
      if (!res.ok) return res;
      return ok({ move: toMove(res.data.move), from_date: res.data.fromDate, to_date: res.data.toDate, shifted: res.data.shifted, preserved: res.data.preserved });
    },
  }),
];
