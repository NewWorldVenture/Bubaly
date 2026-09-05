// To-do and chore tools.
//
// Two legacy dialects meet here. `add_todo` called its subject `task` while
// `add_chore` called it `title`, and both names are baked into stored approval
// payloads and into months of prompting. Rather than break either, the create
// tools accept both keys and check for one of them before anything touches the
// database — the alternative (a required `title`) would silently fail every
// replayed `add_todo` approval.
//
// Everything writes through `lib/services/tasks`, which is where the
// `todo_lists.created_by` / `todo_items.created_by` foreign keys are finally
// satisfied with a `family_members.id` instead of an auth user id.
import 'server-only';
import { z } from 'zod';
import {
  assignChore, assignTodo, completeChoreAssignment, completeTodo, createChore, createTodo,
  listOpenChores, searchTodos,
} from '@/lib/services/tasks';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import { scopeNow } from '@/lib/services/scope';
import type { Priority, RecurrenceFreq } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { resolveAssigneeId } from './family';
import { defineTool, describeDay, describeWhen, plural, type ToolDefinition } from './types';

const TODO_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const CHORE_PRIORITIES = ['low', 'medium', 'high'] as const;
const RECURRENCES = ['none', 'daily', 'weekly', 'monthly', 'yearly'] as const;

const todoOutput = z.object({
  id: z.string(),
  title: z.string(),
  list_id: z.string(),
  due_date: z.string().nullable(),
  priority: z.string(),
  assigned_to_id: z.string().nullable(),
  is_done: z.boolean(),
  /** Family-local phrasing of the due date, or '' when there is none. */
  due: z.string(),
});

const choreAssignmentOutput = z.object({
  id: z.string(),
  chore_id: z.string(),
  member_id: z.string(),
  status: z.string(),
  due_at: z.string().nullable(),
});

export const taskTools: ToolDefinition[] = [
  defineTool({
    name: 'tasks.createTodo',
    aliases: ['add_todo', 'create_todo', 'add_task'],
    description: 'Add a task to the family to-do list.',
    domain: 'tasks',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      title: z.string().nullish().describe('What needs doing'),
      task: z.string().nullish().describe('Legacy name for title; either one works'),
      notes: z.string().nullish(),
      due_date: z.string().nullish().describe('Calendar date, YYYY-MM-DD'),
      priority: z.enum(TODO_PRIORITIES).nullish(),
      assignee: z.string().nullish().describe('Family member name this is for'),
      assignee_id: z.string().nullish(),
      list_id: z.string().nullish().describe('Specific list; omit to use the family default'),
    }),
    output: todoOutput,
    idempotencyFrom: (input) => {
      const title = (input.title ?? input.task ?? '').trim().toLowerCase();
      return title ? `tasks.createTodo:${title}:${input.due_date ?? ''}` : null;
    },
    summarize: (_input, output) => `Added the task ${output.title}${output.due ? ` — due ${output.due}` : ''}`,
    resource: (output) => ({ table: 'todo_items', id: output.id }),
    execute: async (scope, input) => {
      const title = (input.title ?? input.task ?? '').trim();
      if (!title) return fail('A task needs a title.', { code: SERVICE_CODES.invalidInput });

      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;

      const res = await createTodo(scope, {
        title,
        notes: input.notes ?? null,
        dueDate: input.due_date ?? null,
        priority: input.priority ?? undefined,
        listId: input.list_id ?? null,
        // `undefined` lets the service default the assignee to the acting member;
        // an explicit null from the caller is not distinguishable here, and
        // defaulting is the friendlier of the two.
        assigneeId: assignee.data ?? undefined,
      });
      if (!res.ok) return res;
      const todo = res.data;
      return ok({
        id: todo.id, title: todo.title, list_id: todo.list_id, due_date: todo.due_date,
        priority: todo.priority, assigned_to_id: todo.assigned_to_id, is_done: todo.is_done,
        due: todo.due_date ? describeDay(`${todo.due_date}T12:00:00Z`, scope.tz, scopeNow(scope)) : '',
      });
    },
    verify: async (scope, _input, output) => {
      const { data, error } = await scope.db
        .from('todo_items')
        .select('id, title')
        .eq('id', output.id)
        .eq('family_id', scope.familyId)
        .maybeSingle();
      if (error) {
        console.error('[tool:tasks.createTodo] verification read failed', error);
        return fail(describeDbError(error, 'Could not confirm the task was saved.'), { code: SERVICE_CODES.db });
      }
      const found = Boolean(data);
      return ok({ verified: found, detail: found ? `"${output.title}" is on the to-do list.` : 'The task is not on the list.' });
    },
  }),

  defineTool({
    name: 'tasks.completeTodo',
    aliases: ['complete_todo', 'finish_task'],
    description: 'Tick a to-do off (or un-tick it).',
    domain: 'tasks',
    capability: 'edit',
    risk: 'low',
    readOnly: false,
    input: z.object({
      todo_id: z.string(),
      done: z.boolean().nullish().describe('Defaults to true'),
    }),
    output: todoOutput,
    summarize: (_input, output) => (output.is_done ? `Checked off ${output.title}` : `Reopened ${output.title}`),
    resource: (output) => ({ table: 'todo_items', id: output.id }),
    execute: async (scope, input) => {
      const res = await completeTodo(scope, input.todo_id, input.done ?? true);
      if (!res.ok) return res;
      const todo = res.data;
      return ok({
        id: todo.id, title: todo.title, list_id: todo.list_id, due_date: todo.due_date,
        priority: todo.priority, assigned_to_id: todo.assigned_to_id, is_done: todo.is_done,
        due: todo.due_date ? describeDay(`${todo.due_date}T12:00:00Z`, scope.tz, scopeNow(scope)) : '',
      });
    },
  }),

  defineTool({
    name: 'tasks.assignTodo',
    aliases: ['assign_todo', 'assign_task'],
    description: 'Give a to-do to a family member, or take it off them.',
    domain: 'tasks',
    capability: 'edit',
    risk: 'low',
    readOnly: false,
    input: z.object({
      todo_id: z.string(),
      assignee: z.string().nullish().describe('Family member name; omit both to unassign'),
      assignee_id: z.string().nullish(),
    }),
    output: todoOutput,
    summarize: (_input, output) => (output.assigned_to_id ? `Assigned ${output.title}` : `Unassigned ${output.title}`),
    resource: (output) => ({ table: 'todo_items', id: output.id }),
    execute: async (scope, input) => {
      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;

      const res = await assignTodo(scope, input.todo_id, assignee.data);
      if (!res.ok) return res;
      const todo = res.data;
      return ok({
        id: todo.id, title: todo.title, list_id: todo.list_id, due_date: todo.due_date,
        priority: todo.priority, assigned_to_id: todo.assigned_to_id, is_done: todo.is_done,
        due: todo.due_date ? describeDay(`${todo.due_date}T12:00:00Z`, scope.tz, scopeNow(scope)) : '',
      });
    },
  }),

  defineTool({
    name: 'tasks.searchTodos',
    aliases: ['list_todos', 'search_todos'],
    description: 'List to-dos, optionally filtered by person, text or due date.',
    domain: 'tasks',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      query: z.string().nullish(),
      done: z.boolean().nullish().describe('Omit for both open and finished'),
      assignee: z.string().nullish(),
      assignee_id: z.string().nullish(),
      due_before: z.string().nullish().describe('Calendar date, YYYY-MM-DD'),
      limit: z.number().int().nullish(),
    }),
    output: z.object({ todos: z.array(todoOutput) }),
    summarize: (_input, output) => (output.todos.length === 0
      ? 'No matching to-dos'
      : `Found ${plural(output.todos.length, 'to-do')}, starting with ${output.todos[0].title}`),
    execute: async (scope, input) => {
      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;

      const res = await searchTodos(scope, {
        query: input.query ?? null,
        done: input.done ?? undefined,
        assigneeId: assignee.data,
        dueBefore: input.due_before ?? null,
        limit: input.limit ?? undefined,
      });
      if (!res.ok) return res;
      const now = scopeNow(scope);
      return ok({
        todos: res.data.map((todo) => ({
          id: todo.id, title: todo.title, list_id: todo.list_id, due_date: todo.due_date,
          priority: todo.priority, assigned_to_id: todo.assigned_to_id, is_done: todo.is_done,
          due: todo.due_date ? describeDay(`${todo.due_date}T12:00:00Z`, scope.tz, now) : '',
        })),
      });
    },
  }),

  defineTool({
    name: 'tasks.createChore',
    aliases: ['add_chore', 'create_chore'],
    description: 'Create a chore worth points, optionally assigned to someone.',
    domain: 'chores',
    capability: 'create',
    risk: 'low',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      title: z.string().nullish(),
      task: z.string().nullish().describe('Legacy name for title; either one works'),
      description: z.string().nullish(),
      points: z.number().int().nullish().describe('Defaults to 10'),
      priority: z.enum(CHORE_PRIORITIES).nullish(),
      recurrence: z.enum(RECURRENCES).nullish(),
      due_at: z.string().nullish().describe('ISO 8601 datetime'),
      requires_approval: z.boolean().nullish().describe('Defaults to true — a parent confirms before points are awarded'),
      assignee: z.string().nullish(),
      assignee_id: z.string().nullish(),
    }),
    output: z.object({
      id: z.string(),
      title: z.string(),
      points: z.number(),
      due_at: z.string().nullable(),
      assignment: choreAssignmentOutput.nullable(),
      due: z.string(),
    }),
    idempotencyFrom: (input) => {
      const title = (input.title ?? input.task ?? '').trim().toLowerCase();
      return title ? `tasks.createChore:${title}:${input.due_at ?? ''}` : null;
    },
    summarize: (_input, output) => `Added the chore ${output.title} (${output.points} pts)${output.due ? ` due ${output.due}` : ''}`,
    resource: (output) => ({ table: 'chores', id: output.id }),
    execute: async (scope, input) => {
      const title = (input.title ?? input.task ?? '').trim();
      if (!title) return fail('A chore needs a title.', { code: SERVICE_CODES.invalidInput });

      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;

      const res = await createChore(scope, {
        title,
        description: input.description ?? null,
        points: input.points ?? undefined,
        priority: (input.priority ?? undefined) as Priority | undefined,
        recurrence: (input.recurrence ?? undefined) as RecurrenceFreq | undefined,
        dueAt: input.due_at ?? null,
        requiresApproval: input.requires_approval ?? undefined,
        assigneeId: assignee.data,
      });
      if (!res.ok) return res;

      const { chore, assignment } = res.data;
      return ok({
        id: chore.id,
        title: chore.title,
        points: chore.points,
        due_at: chore.due_at,
        assignment: assignment
          ? { id: assignment.id, chore_id: assignment.chore_id, member_id: assignment.member_id, status: assignment.status, due_at: assignment.due_at }
          : null,
        due: chore.due_at ? describeWhen(chore.due_at, scope.tz, scopeNow(scope)) : '',
      });
    },
  }),

  defineTool({
    name: 'tasks.assignChore',
    aliases: ['assign_chore'],
    description: 'Assign an existing chore to a family member.',
    domain: 'chores',
    capability: 'edit',
    risk: 'low',
    readOnly: false,
    input: z.object({
      chore_id: z.string(),
      assignee: z.string().nullish(),
      assignee_id: z.string().nullish(),
      due_at: z.string().nullish(),
    }),
    output: choreAssignmentOutput,
    summarize: (_input, output) => `Assigned that chore${output.due_at ? `, due ${output.due_at}` : ''}`,
    resource: (output) => ({ table: 'chore_assignments', id: output.id }),
    execute: async (scope, input) => {
      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;
      // chore_assignments.member_id is NOT NULL: a chore with nobody on it is a
      // chore nobody does, so this is refused rather than written half-formed.
      if (!assignee.data) return fail('A chore has to be assigned to someone.', { code: SERVICE_CODES.invalidInput });

      const res = await assignChore(scope, { choreId: input.chore_id, memberId: assignee.data, dueAt: input.due_at ?? null });
      if (!res.ok) return res;
      const assignment = res.data;
      return ok({
        id: assignment.id, chore_id: assignment.chore_id, member_id: assignment.member_id,
        status: assignment.status, due_at: assignment.due_at,
      });
    },
  }),

  defineTool({
    name: 'tasks.completeChore',
    aliases: ['complete_chore', 'finish_chore'],
    description: 'Mark a chore assignment done. Chores that need approval go to the parent instead of straight to done.',
    domain: 'chores',
    capability: 'edit',
    risk: 'low',
    readOnly: false,
    input: z.object({ assignment_id: z.string() }),
    output: choreAssignmentOutput,
    summarize: (_input, output) => (output.status === 'submitted'
      ? 'Marked that chore done — waiting on a parent to approve the points'
      : 'Marked that chore done'),
    resource: (output) => ({ table: 'chore_assignments', id: output.id }),
    execute: async (scope, input) => {
      const res = await completeChoreAssignment(scope, input.assignment_id);
      if (!res.ok) return res;
      const assignment = res.data;
      return ok({
        id: assignment.id, chore_id: assignment.chore_id, member_id: assignment.member_id,
        status: assignment.status, due_at: assignment.due_at,
      });
    },
  }),

  defineTool({
    name: 'tasks.listOpenChores',
    aliases: ['list_open_chores'],
    description: 'List chores still to do, soonest due first.',
    domain: 'chores',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      assignee: z.string().nullish(),
      assignee_id: z.string().nullish(),
      limit: z.number().int().nullish(),
    }),
    output: z.object({ assignments: z.array(choreAssignmentOutput) }),
    summarize: (_input, output) => (output.assignments.length === 0
      ? 'The chore board is clear'
      : `${plural(output.assignments.length, 'chore')} still open`),
    execute: async (scope, input) => {
      const assignee = await resolveAssigneeId(scope, input);
      if (!assignee.ok) return assignee;

      const res = await listOpenChores(scope, { memberId: assignee.data, limit: input.limit ?? undefined });
      if (!res.ok) return res;
      return ok({
        assignments: res.data.map((assignment) => ({
          id: assignment.id, chore_id: assignment.chore_id, member_id: assignment.member_id,
          status: assignment.status, due_at: assignment.due_at,
        })),
      });
    },
  }),
];
