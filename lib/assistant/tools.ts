// lib/assistant/tools.ts — the AI Assistant's action toolbox. Each tool the
// model can call maps to a real, RLS-scoped Supabase write so the assistant can
// actually DO things (schedule events, add chores, build lists) — not just talk.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ToolSpec } from '@/lib/ai/provider';

type DB = SupabaseClient<Database>;

export type AssistantCtx = {
  familyId: string;
  userId: string;
  members: { id: string; display_name: string }[];
};

const EVENT_CATEGORIES = ['general', 'school', 'sports', 'appointment', 'medication', 'maintenance', 'birthday', 'holiday', 'other'];

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
function optStr(v: unknown): string | null { const s = str(v); return s || null; }

/** Resolve a member name (case-insensitive, prefix-friendly) to its id. */
function resolveMember(ctx: AssistantCtx, name: unknown): string | null {
  const q = str(name).toLowerCase();
  if (!q) return null;
  const exact = ctx.members.find((m) => m.display_name.toLowerCase() === q);
  if (exact) return exact.id;
  const partial = ctx.members.find((m) => m.display_name.toLowerCase().startsWith(q) || m.display_name.toLowerCase().includes(q));
  return partial?.id ?? null;
}

/** Get-or-create the family's default grocery list. */
async function ensureGroceryList(supabase: DB, familyId: string, userId: string): Promise<string | null> {
  const { data: existing } = await supabase.from('grocery_lists').select('id')
    .eq('family_id', familyId).eq('is_archived', false).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (existing?.id) return existing.id;
  const { data } = await supabase.from('grocery_lists').insert({ family_id: familyId, name: 'Groceries', created_by: userId }).select('id').single();
  return data?.id ?? null;
}

/** Get-or-create the family's default to-do list. */
async function ensureTodoList(supabase: DB, familyId: string, userId: string): Promise<string | null> {
  const { data: existing } = await supabase.from('todo_lists').select('id')
    .eq('family_id', familyId).is('archived_at', null).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (existing?.id) return existing.id;
  const { data } = await supabase.from('todo_lists').insert({ family_id: familyId, name: 'Tasks', created_by: userId }).select('id').single();
  return data?.id ?? null;
}

export function buildAssistantTools(supabase: DB, ctx: AssistantCtx): ToolSpec[] {
  const memberNames = ctx.members.map((m) => m.display_name).join(', ') || 'none';

  return [
    {
      name: 'create_calendar_event',
      description: 'Add an event to the family calendar. Use the family time zone; provide ISO 8601 datetimes.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title' },
          starts_at: { type: 'string', description: 'ISO 8601 start datetime, e.g. 2026-06-24T15:00:00' },
          ends_at: { type: 'string', description: 'ISO 8601 end datetime (optional)' },
          all_day: { type: 'boolean' },
          category: { type: 'string', enum: EVENT_CATEGORIES },
          location: { type: 'string' },
          description: { type: 'string' },
          assignee: { type: 'string', description: `Family member name (one of: ${memberNames})` },
        },
        required: ['title', 'starts_at'],
      },
      execute: async (a) => {
        const title = str(a.title);
        const starts_at = str(a.starts_at);
        if (!title || !starts_at) return { ok: false, error: 'title and starts_at are required' };
        const category = EVENT_CATEGORIES.includes(str(a.category)) ? (str(a.category) as Database['public']['Tables']['calendar_events']['Insert']['category']) : 'general';
        const { data, error } = await supabase.from('calendar_events').insert({
          family_id: ctx.familyId, title, starts_at,
          ends_at: optStr(a.ends_at), all_day: Boolean(a.all_day), category,
          location: optStr(a.location), description: optStr(a.description),
          assignee_id: resolveMember(ctx, a.assignee), created_by: ctx.userId,
        }).select('id').single();
        if (error) return { ok: false, error: error.message };
        return { ok: true, id: data.id, summary: `Added “${title}” to the calendar.` };
      },
    },
    {
      name: 'add_chore',
      description: 'Create a chore, optionally assigned to a family member and worth points.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          points: { type: 'number' },
          due_at: { type: 'string', description: 'ISO 8601 datetime (optional)' },
          assignee: { type: 'string', description: `Family member name (one of: ${memberNames})` },
        },
        required: ['title'],
      },
      execute: async (a) => {
        const title = str(a.title);
        if (!title) return { ok: false, error: 'title is required' };
        const points = Number.isFinite(a.points) ? Math.max(0, Math.round(a.points as number)) : 10;
        const { data: chore, error } = await supabase.from('chores').insert({
          family_id: ctx.familyId, title, points, due_at: optStr(a.due_at), created_by: ctx.userId,
        }).select('id').single();
        if (error) return { ok: false, error: error.message };
        const memberId = resolveMember(ctx, a.assignee);
        if (memberId) {
          await supabase.from('chore_assignments').insert({ family_id: ctx.familyId, chore_id: chore.id, member_id: memberId, due_at: optStr(a.due_at) });
        }
        return { ok: true, id: chore.id, summary: `Created chore “${title}”${memberId ? ` for ${str(a.assignee)}` : ''} (${points} pts).` };
      },
    },
    {
      name: 'add_grocery_item',
      description: 'Add an item to the family grocery list.',
      input_schema: {
        type: 'object',
        properties: { item: { type: 'string' }, quantity: { type: 'string' } },
        required: ['item'],
      },
      execute: async (a) => {
        const name = str(a.item);
        if (!name) return { ok: false, error: 'item is required' };
        const listId = await ensureGroceryList(supabase, ctx.familyId, ctx.userId);
        if (!listId) return { ok: false, error: 'Could not open a grocery list' };
        const { error } = await supabase.from('grocery_items').insert({
          family_id: ctx.familyId, list_id: listId, name, quantity: optStr(a.quantity), created_by: ctx.userId,
        });
        if (error) return { ok: false, error: error.message };
        return { ok: true, summary: `Added ${name} to the grocery list.` };
      },
    },
    {
      name: 'add_todo',
      description: 'Add a task to the family to-do list.',
      input_schema: {
        type: 'object',
        properties: {
          task: { type: 'string' }, notes: { type: 'string' },
          due_date: { type: 'string', description: 'ISO date YYYY-MM-DD (optional)' },
          assignee: { type: 'string', description: `Family member name (one of: ${memberNames})` },
        },
        required: ['task'],
      },
      execute: async (a) => {
        const title = str(a.task);
        if (!title) return { ok: false, error: 'task is required' };
        const listId = await ensureTodoList(supabase, ctx.familyId, ctx.userId);
        if (!listId) return { ok: false, error: 'Could not open a to-do list' };
        const { error } = await supabase.from('todo_items').insert({
          family_id: ctx.familyId, list_id: listId, title, notes: optStr(a.notes),
          due_date: optStr(a.due_date), assigned_to_id: resolveMember(ctx, a.assignee), created_by: ctx.userId,
        });
        if (error) return { ok: false, error: error.message };
        return { ok: true, summary: `Added “${title}” to the to-do list.` };
      },
    },
    {
      name: 'add_reminder',
      description: 'Create a reminder that alerts the family at a specific time.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          remind_at: { type: 'string', description: 'ISO 8601 datetime to remind at' },
          notes: { type: 'string' },
        },
        required: ['title', 'remind_at'],
      },
      execute: async (a) => {
        const title = str(a.title); const remind_at = str(a.remind_at);
        if (!title || !remind_at) return { ok: false, error: 'title and remind_at are required' };
        const { error } = await supabase.from('reminders').insert({
          family_id: ctx.familyId, title, remind_at, notes: optStr(a.notes), created_by: ctx.userId,
        });
        if (error) return { ok: false, error: error.message };
        return { ok: true, summary: `Reminder set: “${title}”.` };
      },
    },
    {
      name: 'add_note',
      description: 'Save a shared family note.',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' } },
        required: ['body'],
      },
      execute: async (a) => {
        const body = str(a.body);
        if (!body) return { ok: false, error: 'body is required' };
        const { error } = await supabase.from('notes').insert({
          family_id: ctx.familyId, title: optStr(a.title), body, created_by: ctx.userId,
        });
        if (error) return { ok: false, error: error.message };
        return { ok: true, summary: 'Saved a family note.' };
      },
    },
    {
      name: 'add_goal',
      description: 'Create a family goal with an optional target date.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' }, description: { type: 'string' },
          target_date: { type: 'string', description: 'ISO date YYYY-MM-DD (optional)' },
        },
        required: ['title'],
      },
      execute: async (a) => {
        const title = str(a.title);
        if (!title) return { ok: false, error: 'title is required' };
        const { error } = await supabase.from('goals').insert({
          family_id: ctx.familyId, title, description: optStr(a.description), target_date: optStr(a.target_date), created_by: ctx.userId,
        });
        if (error) return { ok: false, error: error.message };
        return { ok: true, summary: `Created the goal “${title}”.` };
      },
    },
  ];
}
