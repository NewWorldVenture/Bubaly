// lib/ai/actions.ts — the bridge between AI tool calls and real Supabase writes.
// Every action is RLS-scoped to the caller's family. The AI cannot touch other families'
// data because it runs through the user's authenticated Supabase client.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import type { AITool } from './provider';

type Ctx = { supabase: SupabaseClient<Database>; familyId: string; userId: string };

export const AI_TOOLS: AITool[] = [
  {
    name: 'create_calendar_event',
    description: 'Add an event to the family calendar.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        starts_at: { type: 'string', description: 'ISO 8601 datetime' },
        ends_at: { type: 'string' },
        category: { type: 'string', enum: ['general','school','sports','appointment','medication','maintenance','birthday','holiday','other'] },
      },
      required: ['title', 'starts_at'],
    },
  },
  {
    name: 'create_chore',
    description: 'Create a chore for the household.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' }, points: { type: 'number' }, due_at: { type: 'string' } },
      required: ['title'],
    },
  },
  {
    name: 'create_reminder',
    description: 'Create a reminder (e.g. change the HVAC filter).',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string' }, remind_at: { type: 'string' }, recurrence: { type: 'string' } },
      required: ['title', 'remind_at'],
    },
  },
  {
    name: 'add_grocery_item',
    description: 'Add an item to the weekly grocery list.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, quantity: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'create_meal_plan_entry',
    description: 'Plan a meal on a given date.',
    input_schema: {
      type: 'object',
      properties: { meal_name: { type: 'string' }, plan_date: { type: 'string' }, meal_type: { type: 'string' } },
      required: ['meal_name', 'plan_date'],
    },
  },
];

// Executes a tool call against Supabase. Returns a result the AI can summarize.
// Handles both Magic-Import action names and AI-Assistant chat tool names so
// approved approval_requests payloads can be auto-executed regardless of origin.
export async function runAction(
  ctx: Ctx,
  call: { name: string; args: Record<string, any> },
): Promise<{ ok: boolean; data?: unknown; error?: string; summary?: string }> {
  const { supabase, familyId, userId } = ctx;
  try {
    switch (call.name) {
      // ── Calendar ────────────────────────────────────────────────────────────
      case 'create_calendar_event': {
        const { data, error } = await supabase.from('calendar_events').insert({
          family_id: familyId, created_by: userId,
          title: call.args.title, starts_at: call.args.starts_at,
          ends_at: call.args.ends_at ?? null, category: call.args.category ?? 'general',
          location: call.args.location ?? null, description: call.args.description ?? null,
        }).select().single();
        if (error) return { ok: false, error: error.message };
        return { ok: true, data, summary: `Added "${call.args.title}" to the calendar.` };
      }

      // ── Chores ─────────────────────────────────────────────────────────────
      case 'create_chore':
      case 'add_chore': {
        const { data, error } = await supabase.from('chores').insert({
          family_id: familyId, created_by: userId,
          title: call.args.title, points: call.args.points ?? 10, due_at: call.args.due_at ?? null,
        }).select().single();
        if (error) return { ok: false, error: error.message };
        return { ok: true, data, summary: `Created chore "${call.args.title}".` };
      }

      // ── Reminders ──────────────────────────────────────────────────────────
      case 'create_reminder':
      case 'add_reminder': {
        const { data, error } = await supabase.from('reminders').insert({
          family_id: familyId, created_by: userId,
          title: call.args.title,
          remind_at: call.args.remind_at,
          recurrence: call.args.recurrence ?? 'none',
          notes: call.args.notes ?? null,
        }).select().single();
        if (error) return { ok: false, error: error.message };
        return { ok: true, data, summary: `Reminder set: "${call.args.title}".` };
      }

      // ── Grocery ─────────────────────────────────────────────────────────────
      case 'add_grocery_item': {
        // Resolve list — prefer existing, create if none.
        let listId: string | null = null;
        const { data: existing } = await supabase.from('grocery_lists')
          .select('id').eq('family_id', familyId).eq('is_archived', false)
          .order('created_at', { ascending: true }).limit(1).maybeSingle();
        if (existing?.id) {
          listId = existing.id;
        } else {
          const { data: created } = await supabase.from('grocery_lists')
            .insert({ family_id: familyId, name: 'Groceries', created_by: userId }).select('id').single();
          listId = created?.id ?? null;
        }
        if (!listId) return { ok: false, error: 'Could not open a grocery list.' };
        // Support both arg shapes: {name} from import route, {item} from chat route
        const itemName: string = call.args.name ?? call.args.item ?? '';
        if (!itemName) return { ok: false, error: 'item name is required' };
        const { data, error } = await supabase.from('grocery_items').insert({
          family_id: familyId, list_id: listId, created_by: userId,
          name: itemName, quantity: call.args.quantity ?? null,
        }).select().single();
        if (error) return { ok: false, error: error.message };
        return { ok: true, data, summary: `Added ${itemName} to the grocery list.` };
      }

      // ── Meal plan ───────────────────────────────────────────────────────────
      case 'create_meal_plan_entry': {
        const { data: meal } = await supabase.from('meals').insert({
          family_id: familyId, created_by: userId, name: call.args.meal_name,
          meal_type: call.args.meal_type ?? 'dinner',
        }).select().single();
        const { data, error } = await supabase.from('meal_plans').insert({
          family_id: familyId, created_by: userId, meal_id: meal?.id,
          plan_date: call.args.plan_date, meal_type: call.args.meal_type ?? 'dinner',
        }).select().single();
        if (error) return { ok: false, error: error.message };
        return { ok: true, data, summary: `Planned "${call.args.meal_name}" for ${call.args.plan_date}.` };
      }

      // ── To-dos ─────────────────────────────────────────────────────────────
      case 'add_todo': {
        let listId: string | null = null;
        const { data: existing } = await supabase.from('todo_lists')
          .select('id').eq('family_id', familyId).is('archived_at', null)
          .order('created_at', { ascending: true }).limit(1).maybeSingle();
        if (existing?.id) {
          listId = existing.id;
        } else {
          const { data: created } = await supabase.from('todo_lists')
            .insert({ family_id: familyId, name: 'Tasks', created_by: userId }).select('id').single();
          listId = created?.id ?? null;
        }
        if (!listId) return { ok: false, error: 'Could not open a to-do list.' };
        const title: string = call.args.task ?? call.args.title ?? '';
        if (!title) return { ok: false, error: 'task title is required' };
        const { data, error } = await supabase.from('todo_items').insert({
          family_id: familyId, list_id: listId, created_by: userId,
          title, notes: call.args.notes ?? null, due_date: call.args.due_date ?? null,
        }).select().single();
        if (error) return { ok: false, error: error.message };
        return { ok: true, data, summary: `Added "${title}" to the to-do list.` };
      }

      // ── Notes ──────────────────────────────────────────────────────────────
      case 'add_note': {
        const body: string = call.args.body ?? '';
        if (!body) return { ok: false, error: 'note body is required' };
        const { data, error } = await supabase.from('notes').insert({
          family_id: familyId, created_by: userId,
          title: call.args.title ?? null, body,
        }).select().single();
        if (error) return { ok: false, error: error.message };
        return { ok: true, data, summary: 'Saved a family note.' };
      }

      // ── Goals ──────────────────────────────────────────────────────────────
      case 'add_goal': {
        const title: string = call.args.title ?? '';
        if (!title) return { ok: false, error: 'goal title is required' };
        const { data, error } = await supabase.from('goals').insert({
          family_id: familyId, created_by: userId,
          title, description: call.args.description ?? null, target_date: call.args.target_date ?? null,
        }).select().single();
        if (error) return { ok: false, error: error.message };
        return { ok: true, data, summary: `Created goal "${title}".` };
      }

      // ── Announcements ───────────────────────────────────────────────────────
      case 'create_announcement': {
        const title: string = call.args.title ?? '';
        if (!title) return { ok: false, error: 'announcement title is required' };
        const { data: members } = await supabase.from('family_members')
          .select('id').eq('family_id', familyId).eq('user_id', userId).maybeSingle();
        const { data, error } = await supabase.from('family_announcements').insert({
          family_id: familyId,
          title,
          body: call.args.body ?? null,
          is_pinned: Boolean(call.args.pinned),
          author_member_id: members?.id ?? null,
        }).select().single();
        if (error) return { ok: false, error: error.message };
        return { ok: true, data, summary: `Posted announcement: "${title}".` };
      }

      default:
        return { ok: false, error: `Unknown action: ${call.name}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Action failed' };
  }
}
