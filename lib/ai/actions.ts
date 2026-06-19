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
export async function runAction(
  ctx: Ctx,
  call: { name: string; args: Record<string, any> },
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const { supabase, familyId, userId } = ctx;
  try {
    switch (call.name) {
      case 'create_calendar_event': {
        const { data, error } = await supabase.from('calendar_events').insert({
          family_id: familyId, created_by: userId,
          title: call.args.title, starts_at: call.args.starts_at,
          ends_at: call.args.ends_at ?? null, category: call.args.category ?? 'general',
        }).select().single();
        return error ? { ok: false, error: error.message } : { ok: true, data };
      }
      case 'create_chore': {
        const { data, error } = await supabase.from('chores').insert({
          family_id: familyId, created_by: userId,
          title: call.args.title, points: call.args.points ?? 10, due_at: call.args.due_at ?? null,
        }).select().single();
        return error ? { ok: false, error: error.message } : { ok: true, data };
      }
      case 'create_reminder': {
        const { data, error } = await supabase.from('reminders').insert({
          family_id: familyId, created_by: userId,
          title: call.args.title, remind_at: call.args.remind_at, recurrence: call.args.recurrence ?? 'none',
        }).select().single();
        return error ? { ok: false, error: error.message } : { ok: true, data };
      }
      case 'add_grocery_item': {
        const { data: list } = await supabase.from('grocery_lists')
          .select('id').eq('family_id', familyId).order('created_at').limit(1).single();
        if (!list) return { ok: false, error: 'No grocery list found' };
        const { data, error } = await supabase.from('grocery_items').insert({
          family_id: familyId, list_id: list.id, created_by: userId,
          name: call.args.name, quantity: call.args.quantity ?? null,
        }).select().single();
        return error ? { ok: false, error: error.message } : { ok: true, data };
      }
      case 'create_meal_plan_entry': {
        const { data: meal } = await supabase.from('meals').insert({
          family_id: familyId, created_by: userId, name: call.args.meal_name,
          meal_type: call.args.meal_type ?? 'dinner',
        }).select().single();
        const { data, error } = await supabase.from('meal_plans').insert({
          family_id: familyId, created_by: userId, meal_id: meal?.id,
          plan_date: call.args.plan_date, meal_type: call.args.meal_type ?? 'dinner',
        }).select().single();
        return error ? { ok: false, error: error.message } : { ok: true, data };
      }
      default:
        return { ok: false, error: `Unknown action: ${call.name}` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Action failed' };
  }
}
